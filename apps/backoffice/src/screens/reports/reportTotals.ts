import type { Order } from '@mandalika/api'

export interface ReportTotals {
  /** Completed + refunded money by SALE day (a sale stays on its sale day forever). */
  gross: number
  grossCount: number
  /** Still-completed money by sale day (the server's totalSales). */
  revenue: number
  completedCount: number
  /** Refunded money by REFUND day. */
  refunds: number
  refundedCount: number
  /** gross - refunds; may be negative. */
  net: number
  /** Still-completed revenue grouped by the raw payment method string. */
  byPay: Record<string, number>
  grossByPay: Record<string, number>
  /** Refunds grouped by the ORIGINAL payment method. */
  refundsByPay: Record<string, number>
}

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] || 0) + v
}

/**
 * Client-side reference for the server's /reports/summary aggregation (A27), the parity oracle in
 * tests; the UI reads the server summary. Pass the rows of the SALE-basis list (`saleRows`) and of
 * the `dateBasis=refund` list (`refundRows`) for the same filter. Cancelled is never money.
 * net = gross - refunds, never revenue - refunds: a refunded sale is already missing from revenue.
 */
export function reportTotals(saleRows: readonly Order[], refundRows: readonly Order[]): ReportTotals {
  const t: ReportTotals = {
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  }
  for (const o of saleRows) {
    if (o.status !== 'completed' && o.status !== 'refunded') continue
    t.gross += o.total
    t.grossCount += 1
    add(t.grossByPay, o.paymentMethod, o.total)
    if (o.status === 'completed') {
      t.revenue += o.total
      t.completedCount += 1
      add(t.byPay, o.paymentMethod, o.total)
    }
  }
  for (const o of refundRows) {
    if (o.status !== 'refunded') continue
    t.refunds += o.total
    t.refundedCount += 1
    add(t.refundsByPay, o.paymentMethod, o.total)
  }
  t.net = t.gross - t.refunds
  return t
}
