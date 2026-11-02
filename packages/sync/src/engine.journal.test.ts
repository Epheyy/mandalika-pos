import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { SyncedRefunds, SYNCED_REFUNDS_KEY } from './syncedRefunds'
import { JournalOutboxStore } from './journalOutboxStore'
import { createFakeJournal, type FakeJournal } from './testFixtures/fakeJournal'
import { controllableKV } from './testFixtures/controllableKV'
import { OUTBOX_KEY } from './outbox'
import { PARTIAL_REFUNDS_KEY } from './partialRefunds'

// Phase B / T5 + T7: the engine over the journal store, and synced refunds that are durable BEFORE the
// acked refund row is pruned (a crash between the two self-heals).

type Body = { items: { type: string; idempotencyKey: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const okAll = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })) },
}))

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  okAll.mockClear()
})

async function engineOver(fj: FakeJournal, prefs = controllableKV().kv, request: unknown = okAll) {
  const store = await JournalOutboxStore.open(fj.plugin, prefs)
  const engine = new SyncEngine(api(request), {}, prefs, { actor: null, outboxStore: store })
  return { engine, store, prefs }
}
const online = () => vi.stubGlobal('navigator', { onLine: true })

describe('engine over the journal store', () => {
  it('a queued sale is in the journal and the same item after a restart', async () => {
    const fj = createFakeJournal()
    const { engine } = await engineOver(fj)
    const { idempotencyKey } = await engine.enqueue('order', { orderId: 'o1', total: 10.5 })
    expect(fj.persisted.rows.has(idempotencyKey)).toBe(true)

    const fj2 = fj.restart()
    const { engine: again } = await engineOver(fj2)
    expect(again.pendingCount()).toBe(1)
    const item = again.outbox.all()[0]
    expect(item.idempotencyKey).toBe(idempotencyKey)
    expect(item.payload).toMatchObject({ orderId: 'o1', total: 10.5 })
  })

  it('does not touch Preferences for queue data', async () => {
    const fj = createFakeJournal()
    const prefs = controllableKV()
    const { engine } = await engineOver(fj, prefs.kv)
    await engine.enqueue('order', { orderId: 'o1' })
    expect(prefs.ctl.attempts.filter((a) => a.key === OUTBOX_KEY)).toHaveLength(0)
  })

  it('an engine replaced while an add is in flight: the new engine sees the item after the wiring rule', async () => {
    const fj = createFakeJournal()
    const prefs = controllableKV().kv
    const { engine: a, store } = await engineOver(fj, prefs)
    fj.ctl.mode = 'hold'
    const adding = a.enqueue('order', { orderId: 'o1' })
    await vi.waitFor(() => expect(fj.ctl.held).toHaveLength(1))
    a.dispose()
    const b = new SyncEngine(api(okAll), {}, prefs, { actor: null, outboxStore: store }) // built too early
    expect(b.pendingCount()).toBe(0)
    fj.ctl.held[0].resolve()
    await adding
    await a.idle()
    await store.idle?.()
    await b.rehydrate()
    expect(b.pendingCount()).toBe(1)
    // and its next add cannot collide with the in-flight one
    fj.ctl.mode = 'ok'
    await b.enqueue('order', { orderId: 'o2' })
    expect(b.outbox.all().map((i) => i.seq)).toEqual([1, 2])
  })
})

describe('synced refunds are durable before the acked refund row is pruned (T7)', () => {
  async function ackRefundOver(fj: FakeJournal, prefs = controllableKV().kv) {
    const { engine, store } = await engineOver(fj, prefs)
    await engine.enqueue('refund', { orderId: 'o1', reason: 'rusak' })
    online()
    await engine.flushNow()
    vi.stubGlobal('navigator', { onLine: false })
    return { engine, store, prefs }
  }

  it('orders applied: refund order is in the journal meta, the acked row is pruned, in that order', async () => {
    const fj = createFakeJournal()
    const { engine } = await ackRefundOver(fj)
    expect([...engine.syncedRefundOrderIds()]).toEqual(['o1'])
    expect(fj.persisted.rows.size).toBe(0)
    const kinds = fj.ctl.applies.map((a) => (a.meta?.[SYNCED_REFUNDS_KEY] ? 'meta' : a.deletes.length ? 'delete' : a.upserts.length ? 'upsert' : '?'))
    expect(kinds).toEqual(['upsert', 'upsert', 'meta', 'delete']) // add, settle(ack), addMany, prune
    // the meta write is durable (an applied journal transaction), not a background Preferences set
    expect(JSON.parse(fj.persisted.meta.get(SYNCED_REFUNDS_KEY) as string)[0].orderId).toBe('o1')
  })

  it('addMany fails: the acked row is NOT pruned this round, and a restart self-heals the memory', async () => {
    const fj = createFakeJournal()
    const { engine: first, store, prefs } = await engineOver(fj)
    await first.enqueue('refund', { orderId: 'o1', reason: 'rusak' })
    online()
    fj.ctl.failAt = { nthApply: 3, at: 'beforeCommit' } // add, settle(ack), then the meta write
    await first.flushNow()
    await store.idle?.()
    expect(first.outbox.all().map((i) => i.status)).toEqual(['acked']) // not pruned
    // 2.4.1: the kept acked row already counts, so the refund button does not come back even before the restart.
    expect([...first.syncedRefundOrderIds()]).toEqual(['o1'])
    expect(fj.persisted.rows.size).toBe(1)

    vi.stubGlobal('navigator', { onLine: false })
    const fj2 = fj.restart() // process death between settle and addMany
    const { engine: second } = await engineOver(fj2, prefs)
    await second.idle()
    expect(second.syncedRefundOrderIds().has('o1')).toBe(true) // refund button does not come back
    expect(second.queuedRefundOrderIds().has('o1')).toBe(false)
  })

  it('a refund acked on the KV path also self-heals from a leftover acked row', async () => {
    const acked = { idempotencyKey: 'd:r1', type: 'refund', payload: { orderId: 'o7' }, seq: 1, status: 'acked', clientCreatedAt: 'x' }
    const { kv } = controllableKV({ [OUTBOX_KEY]: JSON.stringify([acked]) })
    const engine = new SyncEngine(api(okAll), {}, kv, { actor: null })
    await engine.idle()
    expect(engine.syncedRefundOrderIds().has('o7')).toBe(true)
  })
})

describe('SyncedRefunds.addMany', () => {
  it('chains its own calls: no overlapping read-modify-write loses an entry', async () => {
    const { kv, ctl, store } = controllableKV()
    ctl.mode = 'hold'
    const s = new SyncedRefunds(kv)
    const p1 = s.addMany(['a'])
    const p2 = s.addMany(['b'])
    await Promise.resolve()
    expect(ctl.held).toHaveLength(1) // the second waits for the first
    ctl.held[0].resolve()
    await vi.waitFor(() => expect(ctl.held).toHaveLength(2))
    ctl.held[1].resolve()
    await Promise.all([p1, p2])
    expect([...s.ids()].sort()).toEqual(['a', 'b'])
    expect(JSON.parse(store.get(SYNCED_REFUNDS_KEY) as string)).toHaveLength(2)
  })
  it('rejects when the durable write fails, and a later call still works', async () => {
    const { kv, ctl } = controllableKV()
    ctl.mode = 'reject'
    const s = new SyncedRefunds(kv)
    await expect(s.addMany(['a'])).rejects.toThrow()
    expect(s.ids().size).toBe(0)
    ctl.mode = 'ok'
    await s.addMany(['a'])
    expect([...s.ids()]).toEqual(['a'])
  })
  it('writes nothing for an empty list and ignores blank ids', async () => {
    const { kv, ctl } = controllableKV()
    const s = new SyncedRefunds(kv)
    await s.addMany([])
    await s.addMany([''])
    expect(ctl.attempts).toHaveLength(0)
  })
})

// A35: a bundle published later may write items with fields or types this bundle has never heard of,
// and an OTA rollback hands that journal to an older bundle. It must adopt it, keep the unknown
// parts through a status rewrite, and send only the wire fields the server knows.
describe('older bundle over a newer bundle journal (A35 rollback tolerance)', () => {
  const futureRow = (key: string, seq: number, type: string) => ({
    key,
    seq,
    json: JSON.stringify({
      idempotencyKey: key,
      type,
      payload: { orderId: key, futurePayloadKey: 1 },
      seq,
      status: 'pending',
      clientCreatedAt: '2026-10-17T00:00:00.000Z',
      futureField: { v: 2 },
    }),
  })

  it('adopts unknown additive fields and an unknown item type', async () => {
    const fj = createFakeJournal()
    fj.persisted.rows.set('d:a', { seq: 1, json: futureRow('d:a', 1, 'order').json })
    fj.persisted.rows.set('d:b', { seq: 2, json: futureRow('d:b', 2, 'future_type').json })
    const { engine } = await engineOver(fj)
    expect(engine.pendingCount()).toBe(2)
    expect(engine.outbox.all().map((i) => i.type)).toEqual(['order', 'future_type'])
  })

  it('keeps unknown fields through a status rewrite and sends only the known wire fields', async () => {
    const fj = createFakeJournal()
    fj.persisted.rows.set('d:a', { seq: 1, json: futureRow('d:a', 1, 'future_type').json })
    const sent: unknown[] = []
    const reject = vi.fn(async (_m: string, _p: string, body: { items: unknown[] }) => {
      sent.push(...body.items)
      return { data: { processed: 0, version: 0, results: [{ idempotencyKey: 'd:a', status: 'error', error: 'x', retryable: true }] } }
    })
    online()
    const { engine } = await engineOver(fj, controllableKV().kv, reject)
    await engine.flush()
    expect(sent).toEqual([
      { type: 'future_type', idempotencyKey: 'd:a', payload: { orderId: 'd:a', futurePayloadKey: 1 } },
    ])
    const stored = JSON.parse(fj.persisted.rows.get('d:a')!.json)
    expect(stored.futureField).toEqual({ v: 2 })
    expect(stored.lastError).toBe('x') // the rewrite really happened
  })
})

describe('receipt archive over the journal store (A41)', () => {
  const ARCHIVE_KEY = 'mandalika.pos.receiptArchive'
  const okWithIds = vi.fn(async (_m: string, _p: string, body: Body) => ({
    data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: `srv-${i.idempotencyKey}` })) },
  }))
  const saleBody = { orderNumber: 'ORD-1', paymentMethod: 'cash', quotedTotal: 1000, customerName: 'Budi', receiptSnapshot: { total: 1000 } }
  const archived = (fj: FakeJournal) => JSON.parse(fj.persisted.meta.get(ARCHIVE_KEY) ?? '[]') as { orderUuid: string; serverOrderId?: string }[]
  const rowStatuses = (fj: FakeJournal) => [...fj.persisted.rows.values()].map((r) => JSON.parse(r.json).status)

  it('archives an acked sale in the journal meta and prunes its row', async () => {
    const fj = createFakeJournal()
    const { engine } = await engineOver(fj, undefined, okWithIds)
    const { orderUuid } = await engine.enqueue('order', saleBody)
    online()
    await engine.flushNow()
    expect(fj.persisted.rows.size).toBe(0)
    expect(archived(fj)).toMatchObject([{ orderUuid, serverOrderId: expect.stringContaining('srv-') }])
    expect(fj.persisted.meta.get(ARCHIVE_KEY)).not.toContain('Budi')
  })

  it('a split sale (tenders in the payload) is archived through the real journal facade and read back intact (C6)', async () => {
    const tenders = [{ method: 'qris', amount: 751000, reference: '8812345' }, { method: 'cash', amount: 600000 }]
    const fj = createFakeJournal()
    const { engine } = await engineOver(fj, undefined, okWithIds)
    const { orderUuid } = await engine.enqueue('order', { ...saleBody, paymentMethod: 'split', tenders })
    online()
    await engine.flushNow()
    expect(fj.persisted.rows.size).toBe(0)
    expect(archived(fj)).toMatchObject([{ orderUuid, tenders }])
    // A restart reads it back from the durable meta, not from memory.
    const { engine: again } = await engineOver(fj.restart(), undefined, okWithIds)
    expect(again.localReceipts()).toMatchObject([{ orderUuid, state: 'synced', paymentMethod: 'split', tenders }])
  })

  it('keeps the acked row when the archive write fails; the next engine start archives it, a later batch prunes it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fj = createFakeJournal()
    let failArchive = true
    const apply = fj.plugin.apply.bind(fj.plugin)
    fj.plugin.apply = (req) =>
      failArchive && req.meta && ARCHIVE_KEY in req.meta ? Promise.reject(new Error('archive write failed (synthetic)')) : apply(req)
    const { engine } = await engineOver(fj, undefined, okWithIds)
    const { orderUuid } = await engine.enqueue('order', saleBody)
    online()
    await engine.flushNow()
    expect(archived(fj)).toEqual([])
    expect(rowStatuses(fj)).toEqual(['acked'])

    failArchive = false
    const fj2 = fj.restart()
    const { engine: again } = await engineOver(fj2, undefined, okWithIds)
    await again.idle()
    expect(archived(fj2).map((e) => e.orderUuid)).toEqual([orderUuid])
    expect(rowStatuses(fj2)).toEqual(['acked'])
    vi.stubGlobal('navigator', { onLine: false })
    await again.enqueue('order', { ...saleBody, orderNumber: 'ORD-2' })
    online()
    await again.flushNow()
    await again.idle()
    expect(fj2.persisted.rows.size).toBe(0)
    expect(archived(fj2)).toHaveLength(2)
  })
})

// 2.4.0 shipped the per-line refund memory without its journal meta key: every write was refused, so the
// dialog offered refunded units again and no acked row was ever pruned (found on a tablet, 2026-10-29).
describe('per-line refunds over the journal store (C4b, 2.4.1)', () => {
  const okWithIds = vi.fn(async (_m: string, _p: string, body: Body) => ({
    data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: `srv-${i.idempotencyKey}` })) },
  }))
  const saleBody = { orderNumber: 'ORD-1', paymentMethod: 'cash', quotedTotal: 450000, receiptSnapshot: { total: 450000 } }
  const partial = { orderId: 'srv-1', reason: 'Berubah pikiran', reasonCode: 'berubah_pikiran', items: [{ lineNo: 0, quantity: 1 }], refundAmount: 225000 }
  const rowTypes = (fj: FakeJournal) => [...fj.persisted.rows.values()].map((r) => JSON.parse(r.json).type)
  const stored = (fj: FakeJournal) => JSON.parse(fj.persisted.meta.get(PARTIAL_REFUNDS_KEY) ?? '[]') as { orderIds: string[]; lines: { lineNo: number; qty: number }[] }[]

  it('stores the memory in the journal meta, counts it, and prunes the acked rows (later sales too)', async () => {
    const fj = createFakeJournal()
    const { engine } = await engineOver(fj, undefined, okWithIds)
    await engine.enqueue('refund', partial)
    online()
    await engine.flushNow()
    expect(stored(fj)).toMatchObject([{ orderIds: expect.arrayContaining(['srv-1']), lines: [{ lineNo: 0, qty: 1 }] }])
    expect(fj.persisted.rows.size).toBe(0)
    expect(engine.partialRefundedQty(['srv-1']).get(0)).toBe(1)
    expect(engine.syncedRefundOrderIds().has('srv-1')).toBe(false) // a partial never marks the order done

    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('order', saleBody)
    online()
    await engine.flushNow()
    expect(fj.persisted.rows.size).toBe(0)
  })

  it('a failing memory write keeps the acked rows, still counts the refund, and a restart stores it once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fj = createFakeJournal()
    const apply = fj.plugin.apply.bind(fj.plugin)
    fj.plugin.apply = (req) =>
      req.meta && PARTIAL_REFUNDS_KEY in req.meta ? Promise.reject(new Error('partial memory write failed (synthetic)')) : apply(req)
    const { engine } = await engineOver(fj, undefined, okWithIds)
    await engine.enqueue('order', saleBody)
    await engine.enqueue('refund', partial)
    online()
    await engine.flushNow()
    expect(rowTypes(fj).sort()).toEqual(['order', 'refund']) // both folds gate the prune: the rows wait
    expect(engine.partialRefundedQty(['srv-1']).get(0)).toBe(1) // never offered again while it waits
    expect(engine.partialRefundedAmount(['srv-1'])).toBe(225000)
    expect(engine.queuedRefundOrderIds().size).toBe(0)

    vi.stubGlobal('navigator', { onLine: false })
    const fj2 = fj.restart() // the next bundle start: the write works again
    const { engine: again } = await engineOver(fj2, undefined, okWithIds)
    await again.idle()
    expect(stored(fj2)).toHaveLength(1)
    expect(again.partialRefundedQty(['srv-1']).get(0)).toBe(1) // stored and still queued: counted once
    expect(again.partialRefundedAmount(['srv-1'])).toBe(225000)
  })
})
