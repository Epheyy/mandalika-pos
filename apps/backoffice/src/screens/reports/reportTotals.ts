import type { Order } from '@mandalika/api'

export interface ReportTotals {
  revenue: number
  completedCount: number
  refunds: number
  refundedCount: number
  /** Completed revenue grouped by the raw payment method string. */
  byPay: Record<string, number>
}

/**
 * Client-side reference for the server's /reports/summary aggregation: only
 * `completed` counts as sales, `refunded` as refunds, `cancelled` as neither.
 * The UI reads the server summary; this exists as the parity oracle in tests.
 */
export function reportTotals(orders: readonly Order[]): ReportTotals {
  const t: ReportTotals = { revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, byPay: {} }
  for (const o of orders) {
    if (o.status === 'completed') {
      t.revenue += o.total
      t.completedCount += 1
      t.byPay[o.paymentMethod] = (t.byPay[o.paymentMethod] || 0) + o.total
    } else if (o.status === 'refunded') {
      t.refunds += o.total
      t.refundedCount += 1
    }
  }
  return t
}
