import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { AppUser } from '@mandalika/types'
import {
  REFUND_NO_PERMISSION, REFUND_NO_SHIFT, REFUND_SHIFT_UNSYNCED,
  refundAvailability, prepareRefund, planRefundSubmit, refundGateProps,
} from './refundView'

type Order = components['schemas']['Order']

const order = (): Order => ({
  id: 'o1', orderNumber: 'BSD-G0007', status: 'completed', total: 225000, paymentMethod: 'cash', shiftId: 'shift-0', items: [],
}) as unknown as Order
const user = (role: AppUser['role']): AppUser => ({
  uid: 'u', displayName: 'K', email: 'k@x', role, permissions: [], createdAt: '2026-10-11T00:00:00Z',
})

describe('L3: shift not yet synced', () => {
  const base = { order: order(), canRefund: true, hasOpenShift: false, queuedOrderIds: new Set<string>() }
  it('says the shift is unsynced when the header shows one without a server id', () => {
    expect(refundAvailability({ ...base, shiftUnsynced: true })).toEqual({ kind: 'blocked', reason: REFUND_SHIFT_UNSYNCED })
    expect(REFUND_SHIFT_UNSYNCED).toBe('Shift belum terkirim')
  })
  it('still says "Buka shift dulu" when there is no shift at all', () => {
    expect(refundAvailability(base)).toEqual({ kind: 'blocked', reason: REFUND_NO_SHIFT })
  })
  it('prepareRefund tells an empty id (unsynced) from none', () => {
    const ok = { order: order(), reason: 'x', canRefund: true }
    expect(prepareRefund({ ...ok, shiftId: '' })).toEqual({ ok: false, message: REFUND_SHIFT_UNSYNCED })
    expect(prepareRefund({ ...ok, shiftId: undefined })).toEqual({ ok: false, message: REFUND_NO_SHIFT })
  })
})

describe('planRefundSubmit (handleRefundConfirm decisions)', () => {
  const ok = { refundOrder: order(), orderId: 'o1', reason: ' rusak ', canRefund: true, shiftId: 'shift-1' }
  it('enqueues exactly the prepared payload', () => {
    const prepared = prepareRefund({ order: order(), reason: ' rusak ', canRefund: true, shiftId: 'shift-1' })
    if (!prepared.ok) throw new Error('unexpected')
    expect(planRefundSubmit(ok)).toEqual({ kind: 'enqueue', payload: prepared.payload })
  })
  it('errors without enqueueing on an order-id mismatch, no open order, no shift, no permission', () => {
    expect(planRefundSubmit({ ...ok, orderId: 'other' }).kind).toBe('error')
    expect(planRefundSubmit({ ...ok, refundOrder: null }).kind).toBe('error')
    expect(planRefundSubmit({ ...ok, shiftId: null })).toEqual({ kind: 'error', message: REFUND_NO_SHIFT })
    expect(planRefundSubmit({ ...ok, canRefund: false })).toEqual({ kind: 'error', message: REFUND_NO_PERMISSION })
  })
})

describe('refundGateProps (what CashierScreen hands OrderHistoryPanel)', () => {
  it('passes permission, open shift and queued ids through', () => {
    expect(refundGateProps({ user: user('admin'), currentShift: { id: 'S' }, queuedOrderIds: new Set(['o1']) }))
      .toEqual({ canRefund: true, hasOpenShift: true, shiftUnsynced: false, queuedRefundOrderIds: new Set(['o1']) })
  })
  it('flags an unsynced shift and a missing shift differently', () => {
    expect(refundGateProps({ user: user('admin'), currentShift: { id: '' }, queuedOrderIds: new Set() })).toMatchObject({ hasOpenShift: false, shiftUnsynced: true })
    expect(refundGateProps({ user: user('admin'), currentShift: null, queuedOrderIds: new Set() })).toMatchObject({ hasOpenShift: false, shiftUnsynced: false })
  })
  it('denies a user without the permission', () => {
    expect(refundGateProps({ user: user('cashier'), currentShift: { id: 'S' }, queuedOrderIds: new Set() }).canRefund).toBe(false)
  })
})
