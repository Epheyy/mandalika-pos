import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { QueuedVoid } from '@mandalika/sync'
import { aggregate } from '../recapAggregate'
import { applyRefundRecap, recapFigures, refundRecap } from '../refundRecap'
import { applyVoidRecap, inRecapShift, pendingVoidReviewBlock, shiftCloseVoidBlock, shiftCorrectionNote, voidRecapOverlay, voidRecapRows } from './voidRecap'

type Order = components['schemas']['Order']
type Shift = components['schemas']['Shift']

const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1', orderNumber: 'BSD-0001', status: 'completed', total: 300000, paymentMethod: 'cash', shiftId: 'S', ...over,
} as Order)
const qv = (over: Partial<QueuedVoid> = {}): QueuedVoid => ({
  idempotencyKey: 'dev:v1', orderId: 'o1', mode: 'replace', status: 'queued', parked: false,
  originalShiftId: 'S', originalTenders: [{ method: 'cash', amount: 300000 }],
  replacementTenders: [{ method: 'qris', amount: 300000 }], ...over,
} as QueuedVoid)
const voided = (over: Partial<Order> = {}): Order => order({
  status: 'cancelled',
  void: { id: 'v', reasonCode: 'salah_barang', voidedAt: '2026-11-14T03:00:00Z', voidedByName: 'Sari', source: 'pos', afterClose: false, mode: 'replace', replacementOrderId: 'o2', replacementOrderNumber: 'BSD-0002' },
  ...over,
})
const methods = [{ id: 'cash', label: 'Tunai', isEnabled: true, isCash: true }, { id: 'qris', label: 'QRIS', isEnabled: true }]

describe('voidRecapRows', () => {
  it('lists a synced void with its replacement number', () => {
    const rows = voidRecapRows([voided()], [], 'S')
    expect(rows).toEqual([expect.objectContaining({ orderNumber: 'BSD-0001', total: 300000, reasonLabel: 'Salah barang', voidedBy: 'Sari', replacementNumber: 'BSD-0002', state: 'synced', followup: 'diganti' })])
  })
  it('lists a queued void once', () => {
    const rows = voidRecapRows([order()], [qv()], 'S')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orderNumber: 'BSD-0001', state: 'queued', followup: 'diganti' })
  })
  it('lists a void once when it is both synced and still queued', () => {
    expect(voidRecapRows([voided()], [qv()], 'S')).toHaveLength(1)
  })
  it('marks a parked void as review and a void-only one as tanpa pengganti', () => {
    const rows = voidRecapRows([order()], [qv({ parked: true, mode: 'none', replacementTenders: undefined })], 'S')
    expect(rows[0]).toMatchObject({ state: 'review', followup: 'tanpa pengganti' })
  })
  it('ignores fsmigrate cancelled orders without void', () => {
    expect(voidRecapRows([order({ status: 'cancelled' })], [], 'S')).toEqual([])
  })
  it('a queued replace void reads diganti with its own facts even when the sale is not loaded', () => {
    const rows = voidRecapRows([], [qv({ orderNumber: 'BSD-0001', reasonCode: 'salah_barang', total: 300000, replacementOrderNumber: 'BSD-0009' })], 'S')
    expect(rows[0]).toMatchObject({ orderNumber: 'BSD-0001', total: 300000, reasonLabel: 'Salah barang', replacementNumber: 'BSD-0009', followup: 'diganti', state: 'queued' })
  })
  it('ignores voids of other shifts', () => {
    expect(voidRecapRows([voided({ shiftId: 'X' })], [qv({ originalShiftId: 'X' })], 'S')).toEqual([])
  })
})

describe('recapAggregate pin', () => {
  it('aggregate still skips cancelled (recapAggregate pin)', () => {
    const b = aggregate([voided(), order({ id: 'o3', total: 100000 })], methods)
    expect(b.totalSales).toBe(100000)
    expect(b.totalOrders).toBe(1)
  })
})

describe('voidRecapOverlay', () => {
  const live = { byMethod: { cash: 500000, qris: 100000 }, totalSales: 600000 }
  const shift = { id: 'S' } as Shift
  it('queued void moves Tunai 300000 to QRIS 300000 in expected figures before sync', () => {
    const f = recapFigures(live, shift, [], [order()], voidRecapOverlay([qv()], [order()], 'S'))
    expect(f.byMethod).toEqual({ cash: 200000, qris: 400000 })
    expect(f.total).toBe(600000)
    expect(f.voidOv.orders).toBe(0)
  })
  it('queued Batalkan saja removes 300000 cash before sync', () => {
    const ov = voidRecapOverlay([qv({ mode: 'none', replacementTenders: undefined })], [order()], 'S')
    expect(ov).toEqual({ byMethod: { cash: -300000 }, total: -300000, orders: -1 })
    expect(applyVoidRecap(live.byMethod, live.totalSales, ov)).toEqual({ byMethod: { cash: 200000, qris: 100000 }, totalSales: 300000 })
  })
  it('overlay ignores a void already reflected as cancelled', () => {
    expect(voidRecapOverlay([qv()], [voided()], 'S')).toEqual({ byMethod: {}, total: 0, orders: 0 })
  })
  it('applies a PARKED void like a queued one (the cashier already handed the money back)', () => {
    const parked = voidRecapOverlay([qv({ parked: true })], [order()], 'S')
    expect(parked).toEqual(voidRecapOverlay([qv()], [order()], 'S'))
    expect(parked).toEqual({ byMethod: { cash: -300000, qris: 300000 }, total: 0, orders: 0 })
    // once it is resolved/discarded it leaves the queue and the overlay is empty again
    expect(voidRecapOverlay([], [order()], 'S')).toEqual({ byMethod: {}, total: 0, orders: 0 })
  })
  it('ignores other shifts and sales still in the outbox', () => {
    const none = { byMethod: {}, total: 0, orders: 0 }
    expect(voidRecapOverlay([qv({ originalShiftId: 'X' })], [order()], 'S')).toEqual(none)
    expect(voidRecapOverlay([qv({ orderId: '' })], [order()], 'S')).toEqual(none)
  })
  it('does not subtract a sale that is no longer completed (refunded elsewhere)', () => {
    expect(voidRecapOverlay([qv({ parked: true })], [order({ status: 'refunded' })], 'S')).toEqual({ byMethod: {}, total: 0, orders: 0 })
  })
  it('ignores a void whose sale is not among the loaded orders', () => {
    expect(voidRecapOverlay([qv()], [], 'S')).toEqual({ byMethod: {}, total: 0, orders: 0 })
  })
  it('composes with the refund overlay without touching it', () => {
    const base = applyRefundRecap(live.byMethod, live.totalSales, refundRecap(shift, []))
    const f = recapFigures(live, shift, [], [order()], voidRecapOverlay([qv({ mode: 'none', replacementTenders: undefined })], [order()], 'S'))
    expect(f.total).toBe(base.total - 300000)
  })
})

describe('inRecapShift', () => {
  it('inRecapShift drops a buat-pengganti order of another shift', () => {
    expect(inRecapShift({ shiftId: 'OLD', replacesOrderId: 'o1' }, 'S')).toBe(false)
    expect(inRecapShift({ shiftId: 'S', replacesOrderId: 'o1' }, 'S')).toBe(true)
    expect(inRecapShift({ shiftId: 'OLD' }, 'S')).toBe(true)
    expect(inRecapShift({ shiftId: null, replacesOrderId: 'o1' }, 'S')).toBe(false)
  })
})

describe('voidRecapOverlay for an unattributed sale', () => {
  it('still overlays a void with no originalShiftId when the orders of the shift hold the sale', () => {
    const ov = voidRecapOverlay([qv({ originalShiftId: null, mode: 'none', replacementTenders: undefined })], [order()], 'S')
    expect(ov.orders).toBe(-1)
    expect(ov.total).toBeLessThan(0)
  })
  it('a void of the sale of another shift is still ignored, and so is an unattributed one the orders do not hold', () => {
    expect(voidRecapOverlay([qv({ originalShiftId: 'OTHER' })], [order()], 'S').orders).toBe(0)
    expect(voidRecapOverlay([qv({ originalShiftId: null, orderId: 'missing' })], [order()], 'S').orders).toBe(0)
  })
})

describe('shiftCloseVoidBlock', () => {
  it('names every unacked void of the shift, queued or parked, and ignores other shifts', () => {
    const msg = shiftCloseVoidBlock([
      qv({ orderNumber: 'BSD-0001' }), qv({ idempotencyKey: 'k2', orderNumber: 'BSD-0002', parked: true }),
      qv({ idempotencyKey: 'k3', orderNumber: 'BSD-0009', originalShiftId: 'OLD' }),
    ], 'S')
    expect(msg).toBe('Selesaikan pembatalan yang tertunda dulu: #BSD-0001, #BSD-0002')
  })
  it("an unattributed void blocks only when its sale is this shift's (loaded order or still-queued sale)", () => {
    const nul = (over: Partial<QueuedVoid> = {}) => qv({ originalShiftId: null, orderNumber: 'BSD-0003', ...over })
    expect(shiftCloseVoidBlock([nul()], 'S', [order()])).toContain('#BSD-0003')
    expect(shiftCloseVoidBlock([nul({ orderId: '', saleOrderUuid: 'u1' })], 'S')).toContain('#BSD-0003')
    expect(shiftCloseVoidBlock([nul({ orderId: 'other' })], 'S', [order()])).toBeNull()
    expect(shiftCloseVoidBlock([nul({ orderId: 'x', saleOrderUuid: 'o1' })], 'S', [order()])).toContain('#BSD-0003')
    // the list shows exactly what the block names
    expect(voidRecapRows([order()], [nul()], 'S').map((r) => r.orderNumber)).toEqual(['BSD-0003'])
    expect(voidRecapRows([order()], [nul({ orderId: 'other' })], 'S')).toEqual([])
  })
  it('is null when nothing is stuck', () => {
    expect(shiftCloseVoidBlock([], 'S')).toBeNull()
    expect(shiftCloseVoidBlock([qv({ originalShiftId: 'OLD' })], 'S')).toBeNull()
  })
})

describe('shiftCorrectionNote', () => {
  const closed = (over: Record<string, unknown> = {}) => ({ status: 'closed', totalSales: 1000000, ...over }) as never
  it('is null for an open shift, a shift without corrections, and a zero count', () => {
    expect(shiftCorrectionNote(closed({ status: 'open', corrections: { count: 1, byMethod: {}, items: [] } }))).toBeNull()
    expect(shiftCorrectionNote(closed())).toBeNull()
    expect(shiftCorrectionNote(closed({ corrections: { count: 0, byMethod: {}, items: [] } }))).toBeNull()
  })
  it('reports the snapshot, the corrected total and the non-zero per-method net', () => {
    const n = shiftCorrectionNote(closed({ correctedTotalSales: 900000, corrections: { count: 2, byMethod: { cash: -100000, qris: 0 }, items: [] } }))
    expect(n).toEqual({ count: 2, snapshotTotal: 1000000, correctedTotal: 900000, byMethod: { cash: -100000 } })
  })
})

describe('pendingVoidReviewBlock', () => {
  it('is null when no other tablet holds a parked void', () => {
    expect(pendingVoidReviewBlock(undefined)).toBeNull()
    expect(pendingVoidReviewBlock(null)).toBeNull()
    expect(pendingVoidReviewBlock([])).toBeNull()
  })
  it('names the stuck transactions once each and says head office has to resolve them', () => {
    const msg = pendingVoidReviewBlock([{ orderNumber: 'BSD-0001' }, { orderNumber: 'BSD-0001' }, { orderNumber: '' }])
    expect(msg).toBe('Selesaikan pembatalan yang tertunda di tablet lain dulu (menunggu Tinjauan Sinkron kantor pusat): #BSD-0001, (tanpa nomor)')
  })
})
