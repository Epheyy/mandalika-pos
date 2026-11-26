import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { aggregate, type PaymentMethodCfg } from './recapAggregate'

type Order = components['schemas']['Order']
const METHODS: PaymentMethodCfg[] = [
  { id: 'cash', label: 'Tunai', isEnabled: true, isCash: true },
  { id: 'qris', label: 'QRIS', isEnabled: true, isCash: false },
]
const X = 'outlet-x'
const Y = 'outlet-y'
const refund = (outletId: string, amount: number, method = 'cash', qty = 1) =>
  ({ id: `r-${outletId}-${amount}`, seq: 1, scope: 'partial', amount, paymentMethod: method, reason: 'x', outletId, items: [{ lineNo: 0, quantity: qty, amount }] })
const order = (extra: Record<string, unknown>): Order =>
  ({
    id: 'o1', orderNumber: 'X-1', outletId: X, status: 'completed', total: 100000, subtotal: 100000, discountAmount: 0, taxAmount: 0,
    paymentMethod: 'cash', items: [{ productId: 'p', productName: 'A', variantSize: '', price: 50000, quantity: 2, subtotal: 100000, lineNo: 0 }],
    ...extra,
  }) as unknown as Order

describe('aggregate with refunds paid at another outlet (A18)', () => {
  const plain = aggregate([order({})], METHODS)

  it('a part refund at another outlet leaves the drawer sale unchanged', () => {
    const o = order({ status: 'partially_refunded', refundedAmount: 50000, refunds: [refund(Y, 50000)] })
    const b = aggregate([o], METHODS)
    expect(b.totalSales).toBe(plain.totalSales)
    expect(b.byMethod).toEqual(plain.byMethod)
    expect(b.cashSales).toBe(plain.cashSales)
    expect(b.refundTotal).toBe(0)
    expect(b.refundCount).toBe(0)
  })

  it('a FULL refund at another outlet keeps the whole sale in this drawer but, like the server (status refunded), not in the order count', () => {
    const o = order({ status: 'refunded', refundedAmount: 100000, refunds: [refund(Y, 100000, 'cash', 2)] })
    const b = aggregate([o], METHODS)
    expect(b.totalSales).toBe(100000)
    expect(b.totalOrders).toBe(0)
    expect(b.byMethod).toEqual({ cash: 100000 })
    expect(b.refundTotal).toBe(0)
    expect(b.net).toBe(plain.net)
  })

  it('a split sale refunded at another outlet keeps every tender line', () => {
    const tenders = [{ seq: 1, method: 'cash', amount: 60000 }, { seq: 2, method: 'qris', amount: 40000 }]
    const o = order({ status: 'refunded', refundedAmount: 100000, tenders, refunds: [refund(Y, 100000, 'cash', 2)] })
    const b = aggregate([o], METHODS)
    expect(b.byMethod).toEqual({ cash: 60000, qris: 40000 })
    expect(b.totalSales).toBe(100000)
  })

  it('a refund paid here still subtracts, and only the part paid here when both happened', () => {
    const here = order({ status: 'partially_refunded', refundedAmount: 30000, refunds: [refund(X, 30000)] })
    expect(aggregate([here], METHODS).totalSales).toBe(70000)
    const both = order({ status: 'refunded', refundedAmount: 100000, refunds: [refund(X, 30000), refund(Y, 70000)] })
    const b = aggregate([both], METHODS)
    expect(b.totalSales).toBe(70000)
    expect(b.refundTotal).toBe(30000)
  })

  it('a refund without outletId (older server) is treated as paid here', () => {
    const r = { ...refund(X, 100000, 'cash', 2), outletId: undefined }
    const o = order({ status: 'refunded', refundedAmount: 100000, refunds: [r] })
    expect(aggregate([o], METHODS).totalSales).toBe(0)
  })
})
