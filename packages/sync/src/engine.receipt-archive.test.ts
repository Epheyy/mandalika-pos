import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARCHIVE_DROP_MAX, ARCHIVE_HOLD_MAX, SyncEngine, type ApiLike } from './engine'
import { RECEIPT_ARCHIVE_KEY, RECEIPT_KEEP_NEWEST, RECEIPT_RETENTION_MS, type ReceiptEntry } from './receiptArchive'
import { SYNCED_REFUNDS_KEY } from './syncedRefunds'
import type { OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// A41: an acked sale leaves the outbox, so its receipt is folded into the archive first. The acked row is
// pruned only when BOTH the refund memory and the archive were written; otherwise it stays and a later
// batch / engine start / rehydrate folds it again.

const OUTBOX_KEY = 'mandalika.pos.outbox'
const NOW = Date.parse('2026-10-20T03:00:00Z')
const DAY = 24 * 60 * 60 * 1000

type Body = { items: { type: string; idempotencyKey: string }[] }
const ok = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: {
    processed: body.items.length, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: `srv-${i.idempotencyKey}` })),
  },
}))
const deny = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: {
    processed: 0, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'conflict', retryable: false })),
  },
}))
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const sale = (n: number) => ({
  orderNumber: `ORD-${n}`, paymentMethod: 'cash', quotedTotal: 1000 * n, total: 1000 * n,
  customerId: 'cust-1', customerName: 'Budi', notes: 'rahasia', salesmanName: 'Sari',
  receiptSnapshot: { total: 1000 * n },
})
const online = () => vi.stubGlobal('navigator', { onLine: true })
const offline = () => vi.stubGlobal('navigator', { onLine: false })
const outboxRows = (store: Map<string, string>): OutboxItem[] => JSON.parse(store.get(OUTBOX_KEY) ?? '[]')
const archive = (store: Map<string, string>): ReceiptEntry[] => JSON.parse(store.get(RECEIPT_ARCHIVE_KEY) ?? '[]')
const newEngine = (kv: ReturnType<typeof controllableKV>['kv'], request: unknown = ok) => new SyncEngine(api(request), {}, kv, { actor: null })

describe('acked sales are archived before the acked row is pruned', () => {
  it('archives the receipt with the server id, without customer data, and prunes the row', async () => {
    const { kv, store } = controllableKV()
    const engine = newEngine(kv)
    const { orderUuid } = await engine.enqueue('order', sale(1))
    online()
    await engine.flushNow()
    expect(outboxRows(store)).toEqual([])
    const [e] = archive(store)
    expect(e).toMatchObject({ orderUuid, orderNumber: 'ORD-1', paymentMethod: 'cash', quotedTotal: 1000, serverOrderId: expect.stringContaining('srv-') })
    expect(JSON.stringify(e)).not.toMatch(/Budi|cust-1|rahasia|Sari/)
  })

  it('localReceipts() exposes the tenders of an archived sale and of a still-queued one (C6)', async () => {
    const tenders = [{ method: 'qris', amount: 751000, reference: '8812345' }, { method: 'cash', amount: 600000 }]
    const { kv } = controllableKV()
    const engine = newEngine(kv)
    await engine.enqueue('order', { ...sale(1), paymentMethod: 'split', tenders })
    expect(engine.localReceipts()[0]).toMatchObject({ state: 'queued', tenders })
    online()
    await engine.flushNow()
    offline()
    expect(engine.localReceipts()[0]).toMatchObject({ state: 'synced', tenders })
    await engine.enqueue('order', { ...sale(2), tenders: [{ method: 'cash', amount: 1 }, null] })
    const [queued, synced] = engine.localReceipts()
    expect(queued).not.toHaveProperty('tenders')
    expect(synced?.tenders).toEqual(tenders)
  })

  it('does not archive a refused (parked) sale and keeps it in the outbox', async () => {
    const { kv, store } = controllableKV()
    const engine = newEngine(kv, deny)
    await engine.enqueue('order', sale(1))
    online()
    await engine.flushNow()
    expect(archive(store)).toEqual([])
    expect(outboxRows(store)).toHaveLength(1)
  })

  it('keeps the acked row when the archive write fails, and the next engine start folds it again', async () => {
    const { kv, store, ctl } = controllableKV()
    ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    const engine = newEngine(kv)
    const { orderUuid } = await engine.enqueue('order', sale(1))
    online()
    await engine.flushNow()
    offline()
    expect(archive(store)).toEqual([])
    const rows = outboxRows(store)
    expect(rows.map((r) => r.status)).toEqual(['acked'])
    expect((rows[0] as OutboxItem & { ackedOrderId?: string }).ackedOrderId).toContain('srv-')

    ctl.modeFor = undefined
    const again = newEngine(kv)
    await again.idle()
    expect(archive(store).map((r) => r.orderUuid)).toEqual([orderUuid])
    // The acked row is still there until a batch prunes it; a new sale's batch does.
    expect(outboxRows(store).map((r) => r.status)).toEqual(['acked'])
    await again.enqueue('order', sale(2))
    online()
    await again.flushNow()
    expect(outboxRows(store)).toEqual([])
    expect(archive(store)).toHaveLength(2)
  })

  it('rehydrate() folds an acked row that a failed write left behind', async () => {
    const { kv, store, ctl } = controllableKV()
    ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    const engine = newEngine(kv)
    await engine.enqueue('order', sale(1))
    online()
    await engine.flushNow()
    offline()
    expect(archive(store)).toEqual([])
    ctl.modeFor = undefined
    await engine.rehydrate()
    expect(archive(store)).toHaveLength(1)
  })

  it('keeps the acked row when only the refund memory write fails (both folds gate the prune)', async () => {
    const { kv, store, ctl } = controllableKV()
    ctl.modeFor = (k) => (k === SYNCED_REFUNDS_KEY ? 'reject' : undefined)
    const engine = newEngine(kv)
    await engine.enqueue('order', sale(1))
    await engine.enqueue('refund', { orderId: 'o1', reason: 'rusak' })
    online()
    await engine.flushNow()
    expect(archive(store)).toHaveLength(1) // the archive itself was written
    expect(outboxRows(store).map((r) => r.status)).toEqual(['acked', 'acked'])
  })

  it('idle() waits for the archive write', async () => {
    const { kv, store, ctl } = controllableKV()
    const engine = newEngine(kv)
    await engine.enqueue('order', sale(1))
    online()
    ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'hold' : undefined)
    const flushed = engine.flushNow()
    await vi.advanceTimersByTimeAsync(0)
    let idle = false
    void engine.idle().then(() => { idle = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(idle).toBe(false)
    ctl.held.find((h) => h.key === RECEIPT_ARCHIVE_KEY)!.resolve()
    await flushed
    await engine.idle()
    expect(archive(store)).toHaveLength(1)
  })
})

describe('a persistently failing archive write is bounded (L1)', () => {
  const failing = () => {
    const c = controllableKV()
    c.ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    return c
  }
  // One sale or cash_flow per round: queue offline, then flush online.
  const round = async (e: SyncEngine, type: 'order' | 'cash_flow', n: number) => {
    offline()
    await e.enqueue(type, type === 'order' ? sale(n) : { amount: n, type: 'in', description: `c${n}` })
    online()
    await e.flushNow()
  }
  const kinds = (store: Map<string, string>) => outboxRows(store).map((r) => `${r.type}:${r.status}`)

  it('holds every acked row until ARCHIVE_HOLD_MAX failed folds, then stops holding the non-sale rows', async () => {
    const { kv, store } = failing()
    const e = newEngine(kv)
    await round(e, 'order', 1)
    for (let n = 2; n < ARCHIVE_HOLD_MAX; n++) await round(e, 'cash_flow', n)
    // ARCHIVE_HOLD_MAX - 1 failed folds so far: everything is still held.
    expect(kinds(store)).toEqual(['order:acked', ...Array(ARCHIVE_HOLD_MAX - 2).fill('cash_flow:acked')])
    await round(e, 'cash_flow', 99)
    // The cap is reached: acked non-sale rows go, the acked SALE row (its only receipt copy) stays.
    expect(kinds(store)).toEqual(['order:acked'])
    expect(archive(store)).toEqual([])
  })

  it('never prunes an acked sale row that is not archived below ARCHIVE_DROP_MAX', async () => {
    const { kv, store } = failing()
    const e = newEngine(kv)
    for (let n = 1; n < ARCHIVE_DROP_MAX; n++) await round(e, 'order', n)
    expect(outboxRows(store)).toHaveLength(ARCHIVE_DROP_MAX - 1)
    expect(outboxRows(store).every((r) => r.status === 'acked' && r.type === 'order')).toBe(true)
  })

  it('at ARCHIVE_DROP_MAX drops the acked sale rows too (already server side) and says so', async () => {
    const { kv, store } = failing()
    const e = newEngine(kv)
    for (let n = 1; n <= ARCHIVE_DROP_MAX; n++) await round(e, 'order', n)
    expect(outboxRows(store)).toEqual([])
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    expect(logged.some((m) => /receipt archive.*dropping/i.test(m))).toBe(true)
  })

  it('a successful fold resets the count: the next failure holds everything again', async () => {
    const c = failing()
    const e = newEngine(c.kv)
    for (let n = 1; n < ARCHIVE_HOLD_MAX; n++) await round(e, 'order', n)
    c.ctl.modeFor = undefined
    await round(e, 'order', 100) // the archive catches up: acked rows fold and prune
    expect(outboxRows(c.store)).toEqual([])
    expect(archive(c.store)).toHaveLength(ARCHIVE_HOLD_MAX)
    c.ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    await round(e, 'order', 101)
    await round(e, 'cash_flow', 102) // failures 1 and 2 of a new run: everything is held again
    expect(kinds(c.store)).toEqual(['order:acked', 'cash_flow:acked'])
  })

  it('a failed refund-memory write still holds every acked row (unchanged)', async () => {
    const { kv, store, ctl } = controllableKV()
    ctl.modeFor = (k) => (k === SYNCED_REFUNDS_KEY || k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    const e = newEngine(kv)
    await round(e, 'order', 1)
    await e.enqueue('refund', { orderId: 'o1', reason: 'r' })
    for (let n = 0; n < ARCHIVE_HOLD_MAX + 2; n++) await round(e, 'cash_flow', n)
    expect(outboxRows(store).every((r) => r.status === 'acked')).toBe(true)
    expect(outboxRows(store).length).toBeGreaterThan(ARCHIVE_HOLD_MAX)
  })
})

describe('the fold prunes with the live outbox as context', () => {
  const entry = (n: number, ageMs: number, extra: Partial<ReceiptEntry> = {}): ReceiptEntry => ({
    orderUuid: `old${n}`, idempotencyKey: `dev:old${n}`, orderNumber: `O${n}`, capturedAt: new Date(NOW - ageMs).toISOString(),
    outletId: '', shiftId: null, paymentMethod: 'cash', quotedTotal: 1, receiptSnapshot: null, archivedAt: NOW, ...extra,
  })
  const seeded = () => {
    const filler = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(1000 + i, DAY + i))
    const old = RECEIPT_RETENTION_MS + DAY
    return [...filler, entry(1, old, { serverOrderId: 'srv-1' }), entry(2, old + 1000), entry(3, old + 2000)]
  }

  it('prunes old receipts beyond 500 on the next fold', async () => {
    const { kv, store } = controllableKV({ [RECEIPT_ARCHIVE_KEY]: JSON.stringify(seeded()) })
    const engine = newEngine(kv)
    await engine.idle()
    const ids = archive(store).map((e) => e.orderUuid)
    expect(ids).toHaveLength(RECEIPT_KEEP_NEWEST)
    expect(ids).not.toContain('old1')
  })

  it('never prunes a receipt named by a queued refund (by saleOrderUuid or by server id)', async () => {
    const seed = controllableKV({ [RECEIPT_ARCHIVE_KEY]: JSON.stringify(seeded()) })
    const queuedBy = (payload: Record<string, unknown>): OutboxItem => ({
      idempotencyKey: `dev:r-${String(payload.saleOrderUuid ?? payload.orderId)}`, type: 'refund', seq: 1, status: 'pending',
      clientCreatedAt: new Date(NOW).toISOString(), payload,
    })
    seed.store.set(OUTBOX_KEY, JSON.stringify([
      { ...queuedBy({ orderId: '', saleOrderUuid: 'old2', reason: 'r' }), seq: 1 },
      { ...queuedBy({ orderId: 'srv-1', reason: 'r' }), seq: 2 },
    ]))
    const engine = newEngine(seed.kv)
    await engine.idle()
    const ids = archive(seed.store).map((e) => e.orderUuid)
    expect(ids).toContain('old1') // via server id
    expect(ids).toContain('old2') // via uuid
    expect(ids).not.toContain('old3')
  })

  it('a parked refund still protects its receipt', async () => {
    const seed = controllableKV({ [RECEIPT_ARCHIVE_KEY]: JSON.stringify(seeded()) })
    seed.store.set(OUTBOX_KEY, JSON.stringify([{
      idempotencyKey: 'dev:r1', type: 'refund', seq: 1, status: 'failed', attempts: 5, reviewCode: 'conflict', reviewReason: 'x',
      clientCreatedAt: new Date(NOW).toISOString(), payload: { orderId: '', saleOrderUuid: 'old3', reason: 'r' },
    }]))
    const engine = newEngine(seed.kv)
    await engine.idle()
    expect(archive(seed.store).map((e) => e.orderUuid)).toContain('old3')
  })
})
