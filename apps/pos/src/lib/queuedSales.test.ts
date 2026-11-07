import { describe, expect, it } from 'vitest'
import { methodDisplayLabel, queuedSalesFrom, queuedTimeText } from './queuedSales'

const r = (over: object) => ({
  orderUuid: 'u', idempotencyKey: 'k', orderNumber: 'L-1', capturedAt: '2026-11-07T07:05:00Z', outletId: 'o', shiftId: null,
  paymentMethod: 'cash', quotedTotal: 1000, receiptSnapshot: null, state: 'queued', refundQueued: false, refunded: false, ...over,
}) as never

describe('queuedSalesFrom', () => {
  it('keeps only queued sales, oldest first', () => {
    const out = queuedSalesFrom([r({ idempotencyKey: 'b', capturedAt: '2026-11-07T08:00:00Z' }), r({ idempotencyKey: 'a' }), r({ idempotencyKey: 'p', state: 'parked' }), r({ idempotencyKey: 's', state: 'synced' })])
    expect(out.map((q) => q.key)).toEqual(['a', 'b'])
  })
  it('names the payment method, and calls a multi-method sale split', () => {
    expect(queuedSalesFrom([r({ paymentMethod: 'qris' })])[0].methodLabel).toBe('QRIS')
    expect(queuedSalesFrom([r({ paymentMethod: 'split', tenders: [{ method: 'cash', amount: 1 }, { method: 'qris', amount: 1 }] })])[0].methodLabel).toBe('Split-Payment')
    expect(queuedSalesFrom([r({ paymentMethod: 'voucher-x' })])[0].methodLabel).toBe('Voucher X')
  })
  it('keeps an unknown total as null instead of inventing one', () => {
    expect(queuedSalesFrom([r({ quotedTotal: null })])[0].total).toBeNull()
  })
})

describe('queuedTimeText', () => {
  const now = new Date(2026, 10, 7, 15, 0).getTime()
  it('shows only the time for today and the date for an earlier day', () => {
    expect(queuedTimeText(new Date(2026, 10, 7, 14, 5).toISOString(), now)).toBe('14:05')
    expect(queuedTimeText(new Date(2026, 10, 5, 14, 5).toISOString(), now)).toMatch(/05.*14:05/)
  })
  it('is empty for an unreadable date', () => {
    expect(queuedTimeText('nope', now)).toBe('')
  })
})

describe('methodDisplayLabel', () => {
  it('names built-ins and makes a Backoffice id readable', () => {
    expect(methodDisplayLabel('cash')).toBe('Tunai')
    expect(methodDisplayLabel('go_pay')).toBe('Go Pay')
  })
})
