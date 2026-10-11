import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { SyncedRefunds, SYNCED_REFUNDS_KEY } from './syncedRefunds'
import { JournalOutboxStore } from './journalOutboxStore'
import { createFakeJournal, type FakeJournal } from './testFixtures/fakeJournal'
import { controllableKV } from './testFixtures/controllableKV'
import { OUTBOX_KEY } from './outbox'

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
    expect(first.syncedRefundOrderIds().size).toBe(0)
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
