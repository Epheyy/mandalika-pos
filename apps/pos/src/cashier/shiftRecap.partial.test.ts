import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { aggregate } from './ShiftRecapPanel'

type Order = components['schemas']['Order']

const methods = [{ id: 'cash', label: 'Tunai', isEnabled: true, isCash: true }, { id: 'qris', label: 'QRIS', isEnabled: true }]
const order = (over: Record<string, unknown>): Order => ({
  id: 'o', status: 'completed', total: 100000, subtotal: 100000, discountAmount: 0, taxAmount: 0, paymentMethod: 'cash',
  items: [{ productId: 'p', productName: 'P', variantSize: '', price: 50000, quantity: 2, subtotal: 100000 }], ...over,
}) as unknown as Order

describe('recap aggregate with per-line refunds (C4b)', () => {
  it('a completed order is a plain sale', () => {
    const b = aggregate([order({})], methods)
    expect(b).toMatchObject({ totalSales: 100000, totalOrders: 1, refundCount: 0, refundTotal: 0, cashSales: 100000 })
  })

  it('a part-refunded order is still a sale, net of what was refunded, and one refund is counted', () => {
    const b = aggregate([order({ status: 'partially_refunded', refundedAmount: 50000, items: [{ productId: 'p', productName: 'P', variantSize: '', price: 50000, quantity: 2, subtotal: 100000, refundedQty: 1 }] })], methods)
    expect(b).toMatchObject({ totalSales: 50000, totalOrders: 1, refundCount: 1, refundTotal: 50000, refundItems: 1, cashSales: 50000 })
    expect(b.byMethod).toEqual({ cash: 50000 })
  })

  it('a fully refunded order is not a sale and counts its amount of record', () => {
    const b = aggregate([order({ status: 'refunded', refundedAmount: 100000 })], methods)
    expect(b).toMatchObject({ totalSales: 0, totalOrders: 0, refundCount: 1, refundTotal: 100000, refundItems: 2 })
  })

  it('a fully refunded order from an older server (no refundedAmount) counts its total', () => {
    expect(aggregate([order({ status: 'refunded' })], methods)).toMatchObject({ refundCount: 1, refundTotal: 100000, totalSales: 0 })
  })

  it('a part-refunded order whose amount is unknown is not guessed', () => {
    expect(aggregate([order({ status: 'partially_refunded' })], methods)).toMatchObject({ totalSales: 100000, refundCount: 0 })
  })

  it('cancelled orders are ignored', () => {
    expect(aggregate([order({ status: 'cancelled' })], methods)).toMatchObject({ totalSales: 0, totalOrders: 0, refundCount: 0 })
  })
})
