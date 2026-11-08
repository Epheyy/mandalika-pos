import { describe, expect, it } from 'vitest'
import { paymentIdsOf } from './useHistoricalPaymentIds'

describe('paymentIdsOf', () => {
  it('unions sale and refund method ids once', () => {
    expect(paymentIdsOf({ grossByPaymentMethod: { cash: 1, qris: 2 }, refundsByPaymentMethod: { qris: 1, gopay: 1 } }).sort())
      .toEqual(['cash', 'gopay', 'qris'])
  })
  it('returns nothing without a summary', () => {
    expect(paymentIdsOf(null)).toEqual([])
    expect(paymentIdsOf({})).toEqual([])
  })
})
