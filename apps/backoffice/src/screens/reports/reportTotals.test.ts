import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { reportTotals } from './reportTotals'

const order = (status: string, total: number, paymentMethod: string): Order =>
  ({ status, total, paymentMethod }) as unknown as Order

// Same shape as the A26 PostgreSQL fixture: cancelled never counts as money,
// payment methods group by the raw string (" QRIS" and "qris" stay separate).
it('totals completed money, refunds and payment breakdown', () => {
  const t = reportTotals(
    [
      order('completed', 16777217.37, ' QRIS'),
      order('completed', 16777219.11, 'qris'),
      order('completed', 12345.67, 'cash'),
      order('refunded', 5000.5, 'cash'),
      order('cancelled', 900, 'cash'),
    ],
    [order('refunded', 5000.5, 'cash')],
  )
  expect(t.revenue).toBeCloseTo(16777217.37 + 16777219.11 + 12345.67, 2)
  expect(t.completedCount).toBe(3)
  expect(t.gross).toBeCloseTo(16777217.37 + 16777219.11 + 12345.67 + 5000.5, 2)
  expect(t.grossCount).toBe(4)
  expect(t.refunds).toBe(5000.5)
  expect(t.refundedCount).toBe(1)
  expect(Object.keys(t.byPay).sort()).toEqual([' QRIS', 'cash', 'qris'])
  expect(t.byPay['cash']).toBe(12345.67)
  expect(t.grossByPay['cash']).toBeCloseTo(12345.67 + 5000.5, 2)
  expect(t.refundsByPay).toEqual({ cash: 5000.5 })
})

it('is all zero for empty lists', () => {
  expect(reportTotals([], [])).toEqual({
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  })
})

// A27 golden numbers: sale X Rp100 cash on D1, refunded on D3. The refund is recognised on the
// refund day; net = gross - refunds (a refunded sale is already missing from totalSales).
describe('refund-day recognition (A27)', () => {
  const sale = order('refunded', 100, 'cash') // sold D1, refunded D3
  it('D1 window: sale rows only', () => {
    const t = reportTotals([sale], [])
    expect(t).toMatchObject({ gross: 100, grossCount: 1, revenue: 0, refunds: 0, net: 100 })
    expect(t.grossByPay).toEqual({ cash: 100 })
    expect(t.refundsByPay).toEqual({})
  })
  it('D2 window: nothing', () => {
    expect(reportTotals([], [])).toMatchObject({ gross: 0, refunds: 0, net: 0 })
  })
  it('D3 window: refund rows only, net is negative', () => {
    const t = reportTotals([], [sale])
    expect(t).toMatchObject({ gross: 0, revenue: 0, refunds: 100, refundedCount: 1, net: -100 })
    expect(t.refundsByPay).toEqual({ cash: 100 })
  })
  it('D1-D3 window: nets to zero, never totalSales - refunds', () => {
    const t = reportTotals([sale], [sale])
    expect(t).toMatchObject({ gross: 100, revenue: 0, refunds: 100, net: 0 })
    expect(t.revenue - t.refunds).toBe(-100) // the double-subtraction trap
  })
  it('ignores cancelled rows on both sides', () => {
    expect(reportTotals([order('cancelled', 900, 'cash')], [order('cancelled', 900, 'cash')])).toMatchObject({ gross: 0, refunds: 0, net: 0 })
  })
})
