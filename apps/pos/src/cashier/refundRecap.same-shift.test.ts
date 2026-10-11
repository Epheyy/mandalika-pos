import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import type { QueuedRefund } from '@mandalika/sync'
import { recapFigures, refundRecap } from './refundRecap'
import { startRefresh } from './recapRefresh'

type Shift = components['schemas']['Shift']
type RecapOrder = Pick<components['schemas']['Order'], 'id' | 'status' | 'total' | 'paymentMethod'>

const shift = (over: Partial<Shift> = {}): Shift => ({
  id: 'S', outletId: 'out', cashierId: 'u', cashierName: 'K', status: 'open', openedAt: '2026-10-11T01:00:00Z',
  startingCash: 0, totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0, ...over,
})
const q = (orderId: string, payload: Record<string, unknown> = {}, over: Partial<QueuedRefund> = {}): QueuedRefund => ({
  idempotencyKey: `dev:${orderId}`, orderId, shiftId: 'S', parked: false, payload: { orderId, ...payload }, ...over,
})
const A: RecapOrder = { id: 'A', status: 'completed', total: 225000, paymentMethod: 'cash' }
const B: RecapOrder = { id: 'B', status: 'completed', total: 275000, paymentMethod: 'cash' }
// What aggregate() gives for completed orders A + B
const live = { byMethod: { cash: 500000 }, totalSales: 500000 }
const figures = (queued: QueuedRefund[], orders: RecapOrder[], s = shift()) => recapFigures(live, s, queued, orders)

describe('H1: same-shift refund while pending', () => {
  it('subtracts the order own total from its own method while it is still completed in liveOrders', () => {
    const r = figures([q('A', { total: 225000, paymentMethod: 'cash', saleShiftId: 'S' })], [A, B])
    expect(r.byMethod.cash).toBe(275000)
    expect(r.total).toBe(275000)
  })
  it('works for a legacy item without a snapshot (server truth from liveOrders)', () => {
    const r = figures([q('A')], [A, B])
    expect(r.byMethod.cash).toBe(275000)
    expect(r.rec.unknownDetailCount).toBe(0)
  })
  it('uses the order, not a wrong snapshot', () => {
    const r = figures([q('A', { total: 1, paymentMethod: 'qris', saleShiftId: 'S' })], [A, B])
    expect(r.byMethod).toEqual({ cash: 275000 })
  })
  it('skips an order already refunded in liveOrders (already out of byMethod)', () => {
    const r = recapFigures({ byMethod: { cash: 275000 }, totalSales: 275000 }, shift(), [q('A', { total: 225000, paymentMethod: 'cash', saleShiftId: 'S' })], [{ ...A, status: 'refunded' }, B])
    expect(r.byMethod.cash).toBe(275000)
  })
  it('pending to acked: right with stale liveOrders, then with the reloaded ones, never twice', () => {
    const pending = [q('A', { total: 225000, paymentMethod: 'cash', saleShiftId: 'S' })]
    expect(figures(pending, [A, B]).total).toBe(275000)
    const after = recapFigures({ byMethod: { cash: 275000 }, totalSales: 275000 }, shift(), [], [{ ...A, status: 'refunded' }, B])
    expect(after.total).toBe(275000)
  })
})

describe('H1: order absent from liveOrders', () => {
  it('cross-shift pending (sale shift differs or is null) is subtracted on top of the server map', () => {
    const s = shift({ refundsPaidByMethod: { cash: 10000 } })
    const r = figures([q('Z', { total: 50000, paymentMethod: 'cash', saleShiftId: 'S0' }), q('Y', { total: 5000, paymentMethod: 'cash', saleShiftId: null })], [A, B], s)
    expect(r.byMethod.cash).toBe(500000 - 10000 - 50000 - 5000)
    expect(r.rec.crossTotal).toBe(65000)
  })
  it('absent and sale shift is this shift: skipped', () => {
    expect(figures([q('Z', { total: 50000, paymentMethod: 'cash', saleShiftId: 'S' })], [A, B]).total).toBe(500000)
  })
  it('absent and no snapshot: a note only', () => {
    const r = figures([q('Z')], [A, B])
    expect(r.total).toBe(500000)
    expect(r.rec.unknownDetailCount).toBe(1)
  })
  it('parked is never subtracted, even when its order is in liveOrders', () => {
    const r = figures([q('A', { total: 225000, paymentMethod: 'cash', saleShiftId: 'S' }, { parked: true })], [A, B])
    expect(r.total).toBe(500000)
    expect(r.rec).toMatchObject({ parkedCount: 1, parkedTotal: 225000 })
  })
  it('without loaded orders it falls back to the snapshot rule', () => {
    expect(refundRecap(shift(), [q('A', { total: 5, paymentMethod: 'cash', saleShiftId: 'S0' })], undefined).crossTotal).toBe(5)
  })
})

describe('M1: queue-change refresh retries after failure', () => {
  it('applies once after transient failures, with backoff', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok')
    const apply = vi.fn()
    startRefresh({ fetch, apply, maxAttempts: 4, baseMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledWith('ok')
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
  it('stops after maxAttempts without applying', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValue(new Error('x'))
    const apply = vi.fn()
    startRefresh({ fetch, apply, maxAttempts: 3, baseMs: 100 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(apply).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('cancel stops pending retries', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValue(new Error('x'))
    const apply = vi.fn()
    const cancel = startRefresh({ fetch, apply, maxAttempts: 5, baseMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    cancel()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
