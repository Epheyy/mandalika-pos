import { expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { reportTotals } from './reportTotals'

const order = (status: string, total: number, paymentMethod: string): Order =>
  ({ status, total, paymentMethod }) as unknown as Order

// Same shape as the A26 PostgreSQL fixture: cancelled never counts as money,
// payment methods group by the raw string (" QRIS" and "qris" stay separate).
it('totals completed money, refunds and payment breakdown', () => {
  const t = reportTotals([
    order('completed', 16777217.37, ' QRIS'),
    order('completed', 16777219.11, 'qris'),
    order('completed', 12345.67, 'cash'),
    order('refunded', 5000.5, 'cash'),
    order('cancelled', 900, 'cash'),
  ])
  expect(t.revenue).toBeCloseTo(16777217.37 + 16777219.11 + 12345.67, 2)
  expect(t.completedCount).toBe(3)
  expect(t.refunds).toBe(5000.5)
  expect(t.refundedCount).toBe(1)
  expect(Object.keys(t.byPay).sort()).toEqual([' QRIS', 'cash', 'qris'])
  expect(t.byPay['cash']).toBe(12345.67)
})

it('is all zero for an empty list', () => {
  expect(reportTotals([])).toEqual({ revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, byPay: {} })
})
