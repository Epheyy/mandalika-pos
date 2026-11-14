import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { QueuedVoid } from '@mandalika/sync'
import { aggregate } from '../recapAggregate'
import { applyRefundRecap, recapFigures, refundRecap } from '../refundRecap'
import { applyVoidRecap, inRecapShift, voidRecapOverlay, voidRecapRows } from './voidRecap'

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
    expect(rows[0]).toMatchObject({ orderNumber: 'BSD-0001', state: 'queued', followup: 'menunggu pengganti' })
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
  it('ignores parked voids, other shifts, and sales still in the outbox', () => {
    const none = { byMethod: {}, total: 0, orders: 0 }
    expect(voidRecapOverlay([qv({ parked: true })], [order()], 'S')).toEqual(none)
    expect(voidRecapOverlay([qv({ originalShiftId: 'X' })], [order()], 'S')).toEqual(none)
    expect(voidRecapOverlay([qv({ orderId: '' })], [order()], 'S')).toEqual(none)
  })
  it('does not add a replacement the server already lists', () => {
    const ov = voidRecapOverlay([qv()], [order(), order({ id: 'o2', replacesOrderId: 'o1' })], 'S')
    expect(ov).toEqual({ byMethod: { cash: -300000 }, total: -300000, orders: -1 })
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
