import { describe, expect, it } from 'vitest'
import { aggregate } from './recapAggregate'

const methods = [{ id: 'cash', label: 'Tunai', isEnabled: true, isCash: true }]
const order = (o: Record<string, unknown>) => ({
  id: 'o', status: 'completed', total: 0, subtotal: 0, discountAmount: 0, taxAmount: 0, paymentMethod: 'cash',
  items: [{ quantity: 1 }], refunds: [], ...o,
}) as never

describe('CS-4 Penjualan Bersih = gross - discount - refunds', () => {
  it('no refunds: gross minus discount', () => {
    const b = aggregate([order({ subtotal: 100000, discountAmount: 10000, total: 90000 })], methods)
    expect(b.net).toBe(90000)
  })
  it('partial refund is subtracted once', () => {
    const b = aggregate([order({ subtotal: 100000, discountAmount: 10000, total: 90000, status: 'completed', refundedAmount: 30000, items: [{ quantity: 2, refundedQty: 1 }] })], methods)
    expect(b.refundTotal).toBe(30000)
    expect(b.net).toBe(100000 - 10000 - 30000)
  })
  it('fully refunded order nets to zero (its refund is not subtracted twice)', () => {
    const b = aggregate([order({ subtotal: 100000, discountAmount: 10000, total: 90000, status: 'refunded', refundedAmount: 90000 })], methods)
    expect(b.gross).toBe(0) // pinned: a fully refunded order is not in gross
    expect(b.discount).toBe(0)
    expect(b.refundTotal).toBe(90000)
    expect(b.net).toBe(0)
    expect(b.totalOrders).toBe(0) // still not a sale count
  })
  it('mixed shift: matches backoffice gross(after discount) - refunds', () => {
    const b = aggregate([
      order({ id: 'a', subtotal: 200000, discountAmount: 20000, total: 180000 }),
      order({ id: 'b', subtotal: 100000, discountAmount: 0, total: 100000, status: 'refunded', refundedAmount: 100000 }),
    ], methods)
    expect(b.net).toBe(180000 + 100000 - 100000)
  })
  it('split-tender refund is counted by its amount, not per method', () => {
    const b = aggregate([order({
      subtotal: 100000, total: 100000, refundedAmount: 40000, items: [{ quantity: 2, refundedQty: 1 }],
      tenders: [{ method: 'cash', amount: 60000 }, { method: 'qris', amount: 40000 }],
      refunds: [{ amount: 40000, paymentMethod: 'qris' }],
    })], methods)
    expect(b.net).toBe(60000)
  })
})

describe('slip arithmetic with one part and one full refund', () => {
  it('Kotor - Diskon - deducted refunds = Bersih; full refund is its own info figure', () => {
    const b = aggregate([
      order({ id: 'a', subtotal: 200000, discountAmount: 20000, total: 180000, refundedAmount: 50000, items: [{ quantity: 2, refundedQty: 1 }] }),
      order({ id: 'b', subtotal: 100000, discountAmount: 0, total: 100000, status: 'refunded', refundedAmount: 100000 }),
    ], methods)
    const deducted = b.refundTotal - b.refundFullTotal
    expect(b.refundTotal).toBe(150000)
    expect(b.refundFullTotal).toBe(100000)
    expect(deducted).toBe(50000)
    expect(b.gross - b.discount - deducted).toBe(b.net)
    expect(b.net).toBe(130000)
  })
})
