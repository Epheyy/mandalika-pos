import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { QueuedRefund } from '@mandalika/sync'
import { applyRefundRecap, refundRecap } from './refundRecap'

type Shift = components['schemas']['Shift']

const shift = (over: Partial<Shift> = {}): Shift => ({
  id: 'S', outletId: 'out', cashierId: 'u', cashierName: 'K', status: 'open', openedAt: '2026-10-11T01:00:00Z',
  startingCash: 0, totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0, ...over,
})
const q = (over: Partial<QueuedRefund> = {}): QueuedRefund => ({
  idempotencyKey: 'dev:r1', orderId: 'o1', shiftId: 'S', parked: false,
  payload: { orderId: 'o1', total: 100000, paymentMethod: 'cash', saleShiftId: 'S0' },
  ...over,
})

// byMethod already excludes same-shift refunds (their orders are status=refunded).
const byMethod = { cash: 500000, qris: 300000 }
const run = (s: Shift | null, queued: QueuedRefund[] = []) => applyRefundRecap(byMethod, 800000, refundRecap(s, queued))

describe('shift recap: refunds paid from this drawer for other shifts', () => {
  it('changes nothing when there are no cross-shift refunds', () => {
    const r = run(shift())
    expect(r.byMethod).toEqual(byMethod)
    expect(r.total).toBe(800000)
    expect(refundRecap(shift(), [])).toMatchObject({ crossTotal: 0, parkedCount: 0, unknownDetailCount: 0 })
  })

  it('subtracts what the server already recorded as paid by this shift', () => {
    const s = shift({ refundsPaidByMethod: { cash: 100000 }, cashRefundsPaid: 100000 })
    const r = run(s)
    expect(r.byMethod).toEqual({ cash: 400000, qris: 300000 })
    expect(r.total).toBe(700000)
    expect(refundRecap(s, []).crossTotal).toBe(100000)
  })

  it('subtracts a queued refund of another shift sale, per its original method', () => {
    const r = run(shift(), [q({ payload: { total: 60000, paymentMethod: 'qris', saleShiftId: 'S0' } })])
    expect(r.byMethod).toEqual({ cash: 500000, qris: 240000 })
    expect(r.total).toBe(740000)
  })

  it('does NOT subtract a queued refund of THIS shift own sale (it leaves byMethod when it syncs)', () => {
    const r = run(shift(), [q({ payload: { total: 60000, paymentMethod: 'cash', saleShiftId: 'S' } })])
    expect(r.byMethod).toEqual(byMethod)
    expect(r.total).toBe(800000)
  })

  it('ignores refunds stamped with a different shift', () => {
    const r = run(shift(), [q({ shiftId: 'other' }), q({ idempotencyKey: 'dev:r2', shiftId: null })])
    expect(r.byMethod).toEqual(byMethod)
  })

  it('adds server and pending amounts together, and tolerates null/undefined server fields', () => {
    const s = shift({ refundsPaidByMethod: { cash: 100000 } })
    const r = run(s, [q({ payload: { total: 50000, paymentMethod: 'cash', saleShiftId: 'S0' } })])
    expect(r.byMethod.cash).toBe(350000)
    expect(run(shift({ refundsPaidByMethod: null, cashRefundsPaid: null })).byMethod).toEqual(byMethod)
    expect(run(shift({ refundsPaidByMethod: undefined })).byMethod).toEqual(byMethod)
    expect(run(null).byMethod).toEqual(byMethod)
  })

  it('counts a refund once as it moves from pending to acknowledged (no double count)', () => {
    const pending = q({ payload: { total: 100000, paymentMethod: 'cash', saleShiftId: 'S0' } })
    const before = run(shift(), [pending])
    expect(before.byMethod.cash).toBe(400000)
    // acked: gone from the queue (it only ever lists unacknowledged items), now in the server map
    const after = run(shift({ refundsPaidByMethod: { cash: 100000 } }), [])
    expect(after.byMethod.cash).toBe(400000)
    expect(after.total).toBe(before.total)
  })

  it('shows parked refunds separately and never subtracts them (the server never counted them)', () => {
    const parked = q({ parked: true, payload: { total: 75000, paymentMethod: 'cash', saleShiftId: 'S0' } })
    const rec = refundRecap(shift(), [parked])
    expect(rec).toMatchObject({ parkedCount: 1, parkedTotal: 75000, crossTotal: 0 })
    expect(applyRefundRecap(byMethod, 800000, rec).byMethod).toEqual(byMethod)
  })

  it('lists legacy queued refunds without sale-shift detail as a note, not in the math', () => {
    const legacy = q({ payload: { orderId: 'o1', reason: 'x' } })
    const rec = refundRecap(shift(), [legacy])
    expect(rec.unknownDetailCount).toBe(1)
    expect(rec.crossTotal).toBe(0)
    expect(applyRefundRecap(byMethod, 800000, rec).total).toBe(800000)
  })

  it('a historical (closed) shift uses only the server snapshot', () => {
    const closed = shift({ status: 'closed', refundsPaidByMethod: { cash: 25000 } })
    expect(applyRefundRecap(byMethod, 800000, refundRecap(closed, undefined)).byMethod.cash).toBe(475000)
  })

  it('total includes methods outside the displayed list', () => {
    const rec = refundRecap(shift({ refundsPaidByMethod: { cash: 10000, gopay: 5000 } }), [])
    const r = applyRefundRecap({ cash: 100000 }, 100000, rec)
    expect(r.total).toBe(85000)
    expect(r.byMethod.cash).toBe(90000)
  })
})
