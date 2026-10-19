import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
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
