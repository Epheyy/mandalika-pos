import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { QueuedRefund } from '@mandalika/sync'
import {
  REFUND_DONE, REFUND_NO_PERMISSION, REFUND_NO_SHIFT, REFUND_QUEUED, REFUND_SHIFT_UNSYNCED,
  planRefundSubmit, prepareRefund, refundAvailability, refundGateProps,
} from './refundView'
import { refundRecap } from './refundRecap'

// A41: a refund of a sale made on this tablet may name the sale by its client orderUuid, because the server id
// of an unsynced sale does not exist yet. Every existing guard still applies; the gate matches on either id.

type Order = components['schemas']['Order']
type Shift = components['schemas']['Shift']

const base = { canRefund: true, hasOpenShift: true, queuedOrderIds: new Set<string>() }
const sale = { orderUuid: 'u-1' }
const localOrder = { id: 'u-1', status: 'completed' as const }

describe('refundAvailability with a local sale', () => {
  it('allows an unsynced sale (uuid only) when every guard passes', () => {
    expect(refundAvailability({ ...base, order: localOrder, sale })).toEqual({ kind: 'allowed' })
  })

  it('keeps the existing guards: permission, shift, unsynced shift, completed status', () => {
    expect(refundAvailability({ ...base, order: localOrder, sale, canRefund: false })).toEqual({ kind: 'blocked', reason: REFUND_NO_PERMISSION })
    expect(refundAvailability({ ...base, order: localOrder, sale, hasOpenShift: false })).toEqual({ kind: 'blocked', reason: REFUND_NO_SHIFT })
    expect(refundAvailability({ ...base, order: localOrder, sale, hasOpenShift: false, shiftUnsynced: true })).toEqual({ kind: 'blocked', reason: REFUND_SHIFT_UNSYNCED })
    expect(refundAvailability({ ...base, order: { ...localOrder, status: 'refunded' }, sale })).toEqual({ kind: 'hidden' })
  })

  it('blocks when an unacknowledged refund names the sale by uuid (the second refund is the double payout)', () => {
    expect(refundAvailability({ ...base, order: localOrder, sale, queuedSaleUuids: new Set(['u-1']) })).toEqual({ kind: 'blocked', reason: REFUND_QUEUED })
  })

  it('blocks when a queued refund names the sale by its server id', () => {
    expect(refundAvailability({ ...base, order: localOrder, sale: { orderUuid: 'u-1', serverOrderId: 'srv-1' }, queuedOrderIds: new Set(['srv-1']) }))
      .toEqual({ kind: 'blocked', reason: REFUND_QUEUED })
  })

  it('shows "Sudah direfund" when the acknowledged-refund memory holds the uuid or the server id', () => {
    expect(refundAvailability({ ...base, order: localOrder, sale, syncedRefundOrderIds: new Set(['u-1']) })).toEqual({ kind: 'blocked', reason: REFUND_DONE })
    expect(refundAvailability({ ...base, order: localOrder, sale: { orderUuid: 'u-1', serverOrderId: 'srv-1' }, syncedRefundOrderIds: new Set(['srv-1']) }))
      .toEqual({ kind: 'blocked', reason: REFUND_DONE })
  })
})

describe('refundAvailability for a server history row cross-matched through the uuid map', () => {
  const row = { id: 'srv-1', status: 'completed' as const }
  const map = new Map([['srv-1', 'u-1']])

  it('is blocked by a queued uuid refund of the same sale', () => {
    expect(refundAvailability({ ...base, order: row, serverIdToSaleUuid: map, queuedSaleUuids: new Set(['u-1']) })).toEqual({ kind: 'blocked', reason: REFUND_QUEUED })
  })

  it('is blocked by an acknowledged uuid refund of the same sale', () => {
    expect(refundAvailability({ ...base, order: row, serverIdToSaleUuid: map, syncedRefundOrderIds: new Set(['u-1']) })).toEqual({ kind: 'blocked', reason: REFUND_DONE })
  })

  it('stays allowed when the map has no entry or the uuid is unrelated', () => {
    expect(refundAvailability({ ...base, order: row, serverIdToSaleUuid: new Map(), queuedSaleUuids: new Set(['u-1']) })).toEqual({ kind: 'allowed' })
    expect(refundAvailability({ ...base, order: row, serverIdToSaleUuid: map, queuedSaleUuids: new Set(['u-9']) })).toEqual({ kind: 'allowed' })
  })
})

describe('prepareRefund / planRefundSubmit for a local sale', () => {
  const orderLike = { id: 'u-1', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', shiftId: 'shift-0' } as unknown as Order
  const input = { order: orderLike, reason: ' salah beli ', canRefund: true, shiftId: 'shift-1' }

  it('unsynced sale: empty orderId plus saleOrderUuid, display snapshot from the receipt', () => {
    expect(prepareRefund({ ...input, sale })).toEqual({
      ok: true,
      payload: { orderId: '', saleOrderUuid: 'u-1', reason: 'salah beli', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', saleShiftId: 'shift-0' },
    })
  })

  it('synced local sale: the known server id is the orderId, the uuid rides along', () => {
    const r = prepareRefund({ ...input, sale: { orderUuid: 'u-1', serverOrderId: 'srv-1' } })
    expect(r).toMatchObject({ ok: true, payload: { orderId: 'srv-1', saleOrderUuid: 'u-1' } })
  })

  it('a history order (no sale) keeps the exact old payload, without a saleOrderUuid key', () => {
    const r = prepareRefund({ ...input, order: { ...orderLike, id: 'srv-9' } as Order })
    expect(r).toMatchObject({ ok: true, payload: { orderId: 'srv-9' } })
    if (r.ok) expect('saleOrderUuid' in r.payload).toBe(false)
  })

  it('refuses without permission, without a shift, with an unsynced shift and with a bad reason', () => {
    expect(prepareRefund({ ...input, sale, canRefund: false })).toEqual({ ok: false, message: REFUND_NO_PERMISSION })
    expect(prepareRefund({ ...input, sale, shiftId: null })).toEqual({ ok: false, message: REFUND_NO_SHIFT })
    expect(prepareRefund({ ...input, sale, shiftId: '' })).toEqual({ ok: false, message: REFUND_SHIFT_UNSYNCED })
    expect(prepareRefund({ ...input, sale, reason: '   ' })).toMatchObject({ ok: false })
    expect(prepareRefund({ ...input, sale, reason: 'x'.repeat(501) })).toMatchObject({ ok: false })
  })

  it('planRefundSubmit enqueues the prepared payload verbatim and still checks the dialog order', () => {
    const plan = planRefundSubmit({ refundOrder: orderLike, orderId: 'u-1', reason: 'salah', canRefund: true, shiftId: 'shift-1', sale })
    expect(plan).toEqual({
      kind: 'enqueue',
      payload: { orderId: '', saleOrderUuid: 'u-1', reason: 'salah', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', saleShiftId: 'shift-0' },
    })
    expect(planRefundSubmit({ refundOrder: orderLike, orderId: 'other', reason: 'salah', canRefund: true, shiftId: 'shift-1', sale })).toMatchObject({ kind: 'error' })
    expect(planRefundSubmit({ refundOrder: null, orderId: 'u-1', reason: 'salah', canRefund: true, shiftId: 'shift-1', sale })).toMatchObject({ kind: 'error' })
  })
})

describe('refundGateProps', () => {
  it('passes the queued sale uuids and the id map through', () => {
    const p = refundGateProps({
      user: { role: 'admin' }, currentShift: { id: 'S' }, queuedOrderIds: new Set(),
      queuedSaleUuids: new Set(['u-1']), serverIdToSaleUuid: new Map([['srv-1', 'u-1']]),
    })
    expect(p.queuedSaleUuids).toEqual(new Set(['u-1']))
    expect(p.serverIdToSaleUuid?.get('srv-1')).toBe('u-1')
  })
})

describe('shift recap with a refund that has no server order id yet', () => {
  const shift = (over: Partial<Shift> = {}): Shift => ({
    id: 'S', outletId: 'out', cashierId: 'u', cashierName: 'K', status: 'open', openedAt: '2026-10-11T01:00:00Z',
    startingCash: 0, totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0, ...over,
  })
  const linked = (saleShiftId: string | null, over: Partial<QueuedRefund> = {}): QueuedRefund => ({
    idempotencyKey: 'dev:r1', orderId: '', shiftId: 'S', parked: false,
    payload: { orderId: '', saleOrderUuid: 'u-1', total: 100000, paymentMethod: 'cash', saleShiftId }, ...over,
  })

  it('an own-shift sale is not subtracted (it was never in the server figures)', () => {
    expect(refundRecap(shift(), [linked('S')])).toMatchObject({ crossTotal: 0, ownPendingTotal: 0, unknownDetailCount: 0 })
  })

  it('a cross-shift sale is subtracted from this drawer by its original method', () => {
    expect(refundRecap(shift(), [linked('S0')])).toMatchObject({ crossByMethod: { cash: 100000 }, crossTotal: 100000 })
  })

  it('M1: a linked refund whose sale has synced follows the loaded/completed rule (the engine hands it the server id)', () => {
    // Cash sale S of THIS shift, refunded offline (R), then S synced while R is still queued.
    const resolved = linked('S', { orderId: 'srv-1' })
    const loaded = [{ id: 'srv-1', status: 'completed' as const, total: 100000, paymentMethod: 'cash' }]
    const r = refundRecap(shift(), [resolved], loaded)
    expect(r).toMatchObject({ ownPendingByMethod: { cash: 100000 }, ownPendingTotal: 100000, crossTotal: 0 })
    // already refunded on the server: already out of the figures
    expect(refundRecap(shift(), [resolved], [{ ...loaded[0], status: 'refunded' as const }]).ownPendingTotal).toBe(0)
  })

  it('a sale without a shift counts as another shift', () => {
    expect(refundRecap(shift(), [linked(null)]).crossTotal).toBe(100000)
  })

  it('a parked linked refund is shown, never subtracted', () => {
    expect(refundRecap(shift(), [linked('S0', { parked: true })])).toMatchObject({ crossTotal: 0, parkedCount: 1, parkedTotal: 100000 })
  })
})
