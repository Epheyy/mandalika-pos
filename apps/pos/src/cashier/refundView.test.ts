import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { MAX_REFUND_REASON_CHARS, UserPermission, canRefund, type AppUser } from '@mandalika/types'
import {
  REFUND_NO_PERMISSION, REFUND_NO_SHIFT, REFUND_QUEUED,
  refundAvailability, prepareRefund, refundDetail, canSubmitRefundReason,
} from './refundView'
import { RefundAction } from './RefundAction'
import { RefundDialog } from './RefundDialog'

type Order = components['schemas']['Order']

const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1', orderNumber: 'BSD-G0007', status: 'completed', total: 225000, paymentMethod: 'cash', shiftId: 'shift-0', items: [],
  ...over,
}) as Order

const user = (role: AppUser['role'], permissions: AppUser['permissions'] = []): AppUser => ({
  uid: 'u', displayName: 'Kasir', email: 'k@x', role, permissions, createdAt: '2026-10-11T00:00:00Z',
})

describe('canRefund (UI gate, server decides)', () => {
  it('lets an admin refund without an explicit permission', () => {
    expect(canRefund(user('admin'))).toBe(true)
  })
  it('lets a cashier with process_refund refund', () => {
    expect(canRefund(user('cashier', [UserPermission.PROCESS_REFUND]))).toBe(true)
  })
  it('refuses a cashier without the permission', () => {
    expect(canRefund(user('cashier', [UserPermission.VIEW_REPORTS]))).toBe(false)
  })
  it('refuses nobody-signed-in and tolerates missing permissions', () => {
    expect(canRefund(null)).toBe(false)
    expect(canRefund(undefined)).toBe(false)
    expect(canRefund({ ...user('cashier'), permissions: undefined as unknown as AppUser['permissions'] })).toBe(false)
  })
})

describe('refundAvailability', () => {
  const base = { order: order(), canRefund: true, hasOpenShift: true, queuedOrderIds: new Set<string>() }
  it('allows a completed order for a permitted user with an open shift and nothing queued', () => {
    expect(refundAvailability(base)).toEqual({ kind: 'allowed' })
  })
  it('is hidden for orders that are not completed', () => {
    expect(refundAvailability({ ...base, order: order({ status: 'refunded' }) })).toEqual({ kind: 'hidden' })
    expect(refundAvailability({ ...base, order: order({ status: 'cancelled' }) })).toEqual({ kind: 'hidden' })
  })
  it('explains a missing permission', () => {
    expect(refundAvailability({ ...base, canRefund: false })).toEqual({ kind: 'blocked', reason: REFUND_NO_PERMISSION })
    expect(REFUND_NO_PERMISSION).toBe('Butuh izin Proses Refund')
  })
  it('explains a queued or parked refund for the same order only', () => {
    expect(refundAvailability({ ...base, queuedOrderIds: new Set(['o1']) })).toEqual({ kind: 'blocked', reason: REFUND_QUEUED })
    expect(refundAvailability({ ...base, queuedOrderIds: new Set(['other']) })).toEqual({ kind: 'allowed' })
    expect(REFUND_QUEUED).toBe('Refund menunggu sinkronisasi')
  })
  it('blocks when no shift is open (B3)', () => {
    expect(refundAvailability({ ...base, hasOpenShift: false })).toEqual({ kind: 'blocked', reason: REFUND_NO_SHIFT })
    expect(REFUND_NO_SHIFT).toBe('Buka shift dulu')
  })
})

describe('RefundAction render', () => {
  const render = (over: Partial<Parameters<typeof RefundAction>[0]> = {}) => renderToStaticMarkup(createElement(RefundAction, {
    order: order(), canRefund: true, hasOpenShift: true, queuedOrderIds: new Set<string>(), onRefund: vi.fn(), ...over,
  }))
  it('shows the button when allowed', () => {
    expect(render()).toContain('Refund Transaksi Ini')
  })
  it.each([
    ['no permission', { canRefund: false }, 'Butuh izin Proses Refund'],
    ['queued', { queuedOrderIds: new Set(['o1']) }, 'Refund menunggu sinkronisasi'],
    ['no shift', { hasOpenShift: false }, 'Buka shift dulu'],
  ])('replaces the button with a muted line: %s', (_n, over, text) => {
    const html = render(over)
    expect(html).not.toContain('Refund Transaksi Ini')
    expect(html).toContain(text)
  })
  it('renders nothing for a refunded order', () => {
    expect(render({ order: order({ status: 'refunded' }) })).toBe('')
  })
})

describe('prepareRefund (CashierScreen guard + queue-time snapshot)', () => {
  const ok = { order: order(), reason: '  rusak  ', canRefund: true, shiftId: 'shift-1' }
  it('writes the display snapshot once, with the trimmed reason and the SALE shift', () => {
    expect(prepareRefund(ok)).toEqual({
      ok: true,
      payload: { orderId: 'o1', reason: 'rusak', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', saleShiftId: 'shift-0' },
    })
  })
  it('records a null sale shift when history does not know it', () => {
    const r = prepareRefund({ ...ok, order: order({ shiftId: null }) })
    expect(r).toMatchObject({ ok: true, payload: { saleShiftId: null } })
  })
  it('refuses without permission, without a synced open shift, or with a blank/long reason', () => {
    expect(prepareRefund({ ...ok, canRefund: false })).toEqual({ ok: false, message: REFUND_NO_PERMISSION })
    expect(prepareRefund({ ...ok, shiftId: null })).toEqual({ ok: false, message: REFUND_NO_SHIFT })
    expect(prepareRefund({ ...ok, shiftId: '' })).toEqual({ ok: false, message: 'Shift belum tersinkron' }) // L3: shown but unsynced
    expect(prepareRefund({ ...ok, reason: '   ' })).toMatchObject({ ok: false })
    expect(prepareRefund({ ...ok, reason: 'x'.repeat(MAX_REFUND_REASON_CHARS + 1) })).toMatchObject({ ok: false })
    expect(prepareRefund({ ...ok, reason: 'x'.repeat(MAX_REFUND_REASON_CHARS) })).toMatchObject({ ok: true })
  })
})

describe('refundDetail (review row)', () => {
  it('formats order number, amount and method from the captured snapshot', () => {
    const d = refundDetail({ orderId: 'o1', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash' })
    expect(d).toMatch(/^BSD-G0007 · Rp\s225\.000 · Tunai$/)
  })
  it('falls back to the raw id for a custom method', () => {
    expect(refundDetail({ orderNumber: 'A-1', total: 1000, paymentMethod: 'gopay' })).toMatch(/· gopay$/)
  })
  it('is undefined for an old item without the snapshot keys', () => {
    expect(refundDetail({ orderId: 'o1', reason: 'x' })).toBeUndefined()
    expect(refundDetail(undefined)).toBeUndefined()
  })
})

describe('RefundDialog reason limit', () => {
  const html = renderToStaticMarkup(createElement(RefundDialog, { order: order(), isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn() }))
  it('caps the textarea at the shared limit and shows a counter', () => {
    expect(MAX_REFUND_REASON_CHARS).toBe(500)
    expect(html).toContain(`maxLength="${MAX_REFUND_REASON_CHARS}"`)
    expect(html).toContain(`0/${MAX_REFUND_REASON_CHARS}`)
  })
  it('disables submit for a blank reason', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Konfirmasi Refund/)
    expect(canSubmitRefundReason('   ')).toBe(false)
    expect(canSubmitRefundReason(' a ')).toBe(true)
    expect(canSubmitRefundReason('x'.repeat(MAX_REFUND_REASON_CHARS + 1))).toBe(false)
  })
})
