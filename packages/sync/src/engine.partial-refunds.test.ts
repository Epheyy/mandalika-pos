import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { SYNCED_REFUNDS_KEY } from './syncedRefunds'
import {
  PARTIAL_REFUNDS_KEY, PARTIAL_REFUNDS_MAX, PARTIAL_REFUNDS_TTL_MS, PartialRefunds, partialRefundFromPayload, type PartialRefundEntry,
} from './partialRefunds'
import { controllableKV } from './testFixtures/controllableKV'

// C4b: a per-line refund (payload `items`) is remembered in the NEW partial store, never in the whole-order
// "done" memory, unless the server says it left the order fully refunded.

type Body = { items: { type: string; idempotencyKey: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const answer = (refundState?: 'partial' | 'full') =>
  vi.fn(async (_m: string, _p: string, body: Body) => ({
    data: {
      processed: body.items.length, version: 0,
      results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: 'srv-1', ...(refundState ? { refundState } : {}) })),
    },
  }))

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-28T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const partialPayload = (orderId = 'srv-1', items = [{ lineNo: 0, quantity: 1 }], amount = 35000) => ({
  orderId, reason: 'Rusak/cacat', reasonCode: 'damaged', items, refundAmount: amount,
})

async function sendRefund(request: unknown, payload: Record<string, unknown>, kv = controllableKV().kv) {
  const engine = new SyncEngine(api(request), {}, kv, { actor: null })
  await engine.enqueue('refund', payload)
  vi.stubGlobal('navigator', { onLine: true })
  await engine.flushNow()
  vi.stubGlobal('navigator', { onLine: false })
  return { engine, kv }
}

describe('engine: acknowledged per-line refunds', () => {
  it('a partial ack lands in the partial store and does NOT mark the order done', async () => {
    const { engine } = await sendRefund(answer('partial'), partialPayload())
    expect(engine.syncedRefundOrderIds().size).toBe(0)
    expect(engine.partialRefundedQty(['srv-1']).get(0)).toBe(1)
    expect(engine.partialRefundedAmount(['srv-1'])).toBe(35000)
    expect(engine.queuedRefundOrderIds().size).toBe(0)
  })

  it('a full ack of a per-line refund also marks the order done, and keeps the quantities', async () => {
    const { engine } = await sendRefund(answer('full'), partialPayload())
    expect(engine.syncedRefundOrderIds().has('srv-1')).toBe(true)
    expect(engine.partialRefundedQty(['srv-1']).get(0)).toBe(1)
  })

  it('an ack without refundState (older server) is treated as partial, never as the whole order', async () => {
    const { engine } = await sendRefund(answer(undefined), partialPayload())
    expect(engine.syncedRefundOrderIds().size).toBe(0)
    expect(engine.partialRefundedQty(['srv-1']).get(0)).toBe(1)
  })

  it('a legacy whole-order refund still goes to the synced-refund memory only', async () => {
    const { engine } = await sendRefund(answer('full'), { orderId: 'srv-1', reason: 'rusak' })
    expect(engine.syncedRefundOrderIds().has('srv-1')).toBe(true)
    expect(engine.partialRefundedQty(['srv-1']).size).toBe(0)
  })

  it('names the order under both its sale uuid and its server id', async () => {
    const { engine } = await sendRefund(answer('partial'), { saleOrderUuid: 'uuid-9', reason: 'r', items: [{ lineNo: 2, quantity: 3 }], refundAmount: 9 })
    expect(engine.partialRefundedQty(['uuid-9']).get(2)).toBe(3)
    expect(engine.partialRefundedQty(['srv-1']).get(2)).toBe(3)
  })

  it('survives an app restart and sums two refunds of the same line', async () => {
    const kv = controllableKV().kv
    await sendRefund(answer('partial'), partialPayload('srv-1', [{ lineNo: 0, quantity: 1 }], 100), kv)
    const second = await sendRefund(answer('partial'), partialPayload('srv-1', [{ lineNo: 0, quantity: 2 }, { lineNo: 1, quantity: 1 }], 250), kv)
    const again = new SyncEngine(api(answer('partial')), {}, kv, { actor: null })
    expect(again.partialRefundedQty(['srv-1']).get(0)).toBe(3)
    expect(again.partialRefundedQty(['srv-1']).get(1)).toBe(1)
    expect(again.partialRefundedAmount(['srv-1'])).toBe(350)
    expect(second.engine.partialRefundedQty(['other']).size).toBe(0)
  })

  it('startup self-heal records an acked per-line row without marking the order done, and never double-counts', async () => {
    const { kv, ctl } = controllableKV()
    // The crash between ack and the partial-store write: the write fails, so the acked row stays in the outbox.
    ctl.modeFor = (key) => (key === PARTIAL_REFUNDS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await sendRefund(answer('partial'), partialPayload(), kv)
    ctl.modeFor = undefined
    const heal = new SyncEngine(api(answer('partial')), {}, kv, { actor: null })
    await heal.rehydrate()
    expect(heal.syncedRefundOrderIds().size).toBe(0)
    expect(heal.partialRefundedQty(['srv-1']).get(0)).toBe(1)
    await heal.rehydrate() // folding again is not a second refund
    expect(heal.partialRefundedQty(['srv-1']).get(0)).toBe(1)
  })

  it('keeps the acked row when the partial store write fails', async () => {
    const { kv, ctl } = controllableKV()
    ctl.modeFor = (key) => (key === PARTIAL_REFUNDS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { engine } = await sendRefund(answer('partial'), partialPayload(), kv)
    expect(engine.outbox.all().some((i) => i.type === 'refund' && i.status === 'acked')).toBe(true)
  })

  it('rollback simulation: the payload of a queued per-line refund is untouched (resent verbatim)', async () => {
    const kv = controllableKV().kv
    const engine = new SyncEngine(api(answer('partial')), {}, kv, { actor: null })
    const payload = partialPayload()
    await engine.enqueue('refund', payload)
    const queued = engine.queuedRefunds()[0]
    expect(queued.payload.items).toEqual(payload.items)
    expect(queued.payload.refundAmount).toBe(35000)
    expect(queued.payload.reasonCode).toBe('damaged')
    expect(engine.queuedRefundOrderIds().has('srv-1')).toBe(true)
  })

  it('does not touch the journal-guarded synced-refund key for a partial refund', async () => {
    const { kv, store } = controllableKV()
    await sendRefund(answer('partial'), partialPayload(), kv)
    expect(store.has(SYNCED_REFUNDS_KEY)).toBe(false)
    expect(store.has(PARTIAL_REFUNDS_KEY)).toBe(true)
  })
})

describe('PartialRefunds store', () => {
  const entry = (n: number, over: Partial<PartialRefundEntry> = {}): PartialRefundEntry => ({
    refundKey: `k${n}`, orderIds: [`o${n}`], lines: [{ lineNo: 0, qty: 1 }], amount: 10, at: Date.now(), ...over,
  })

  it('keeps only the newest PARTIAL_REFUNDS_MAX entries', async () => {
    const s = new PartialRefunds(controllableKV().kv)
    await s.addMany(Array.from({ length: PARTIAL_REFUNDS_MAX + 5 }, (_, i) => entry(i)))
    expect(s.entries().length).toBe(PARTIAL_REFUNDS_MAX)
    expect(s.refundedQty(['o0']).size).toBe(0)
    expect(s.refundedQty([`o${PARTIAL_REFUNDS_MAX + 4}`]).get(0)).toBe(1)
  })

  it('drops entries older than the retention window', async () => {
    const s = new PartialRefunds(controllableKV().kv)
    await s.addMany([entry(1)])
    vi.setSystemTime(Date.now() + PARTIAL_REFUNDS_TTL_MS + 1000)
    expect(s.entries()).toEqual([])
  })

  it('adding the same refund key twice is not a second refund', async () => {
    const s = new PartialRefunds(controllableKV().kv)
    await s.addMany([entry(1), entry(1)])
    await s.addMany([entry(1)])
    expect(s.refundedQty(['o1']).get(0)).toBe(1)
  })

  it('is empty and safe on corrupt or malformed storage', () => {
    expect(new PartialRefunds(controllableKV({ [PARTIAL_REFUNDS_KEY]: '{broken' }).kv).entries()).toEqual([])
    const junk = JSON.stringify([{ refundKey: 'k', orderIds: [], lines: [], amount: 1, at: 1 }, null, 'x', { refundKey: 'k2', orderIds: ['o'], lines: [{ lineNo: 0, qty: 0 }], amount: 1, at: Date.now() }])
    expect(new PartialRefunds(controllableKV({ [PARTIAL_REFUNDS_KEY]: junk }).kv).entries()).toEqual([])
  })

  it('rejects when the durable write fails, so the caller keeps the acked row', async () => {
    const { kv, ctl } = controllableKV()
    ctl.mode = 'reject'
    await expect(new PartialRefunds(kv).addMany([entry(1)])).rejects.toThrow()
  })
})

describe('partialRefundFromPayload', () => {
  it('is null for a legacy whole-order payload and for malformed items', () => {
    expect(partialRefundFromPayload('k', { orderId: 'o', reason: 'r' })).toBeNull()
    expect(partialRefundFromPayload('k', { orderId: 'o', items: [] })).toBeNull()
    expect(partialRefundFromPayload('k', { orderId: 'o', items: [{ lineNo: 0, quantity: 0 }] })).toBeNull()
    expect(partialRefundFromPayload('k', { orderId: 'o', items: [{ lineNo: -1, quantity: 1 }] })).toBeNull()
    expect(partialRefundFromPayload('k', { items: [{ lineNo: 0, quantity: 1 }] })).toBeNull()
    expect(partialRefundFromPayload('', { orderId: 'o', items: [{ lineNo: 0, quantity: 1 }] })).toBeNull()
  })
  it('reads the lines, ids and the paid-out amount', () => {
    expect(partialRefundFromPayload('k', { orderId: 'o', saleOrderUuid: 'u', items: [{ lineNo: 1, quantity: 2 }], refundAmount: 50 }, ['srv'], 7)).toEqual({
      refundKey: 'k', orderIds: ['o', 'u', 'srv'], lines: [{ lineNo: 1, qty: 2 }], amount: 50, at: 7,
    })
  })
})
