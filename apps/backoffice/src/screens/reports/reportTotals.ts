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

/** True for the two states that carry refund money (C4a: partially_refunded joins refunded). */
export const isRefundedStatus = (status: string): boolean => status === 'refunded' || status === 'partially_refunded'

/** Money refunded on an order: the server's sum of refund rows, else the whole total (legacy / older backend). */
export const refundedMoney = (o: Pick<Order, 'total' | 'refundedAmount'>): number => o.refundedAmount ?? o.total

/** Money of a sale that is still sold: a partial refund leaves total - refundedAmount (never below 0). */
export const stillSoldMoney = (o: Pick<Order, 'status' | 'total' | 'refundedAmount'>): number =>
  o.status === 'partially_refunded' ? Math.max(o.total - (o.refundedAmount ?? 0), 0) : o.total

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] || 0) + v
}

/**
 * Client-side reference for the server's /reports/summary aggregation (A27), the parity oracle in
 * tests; the UI reads the server summary. Pass the rows of the SALE-basis list (`saleRows`) and of
 * the `dateBasis=refund` list (`refundRows`) for the same filter. Cancelled is never money.
 * net = gross - refunds, never revenue - refunds: a refunded sale is already missing from revenue.
 * C4a: a partially_refunded sale is a sale (counted in gross and completedCount); its revenue is net
 * of what was refunded, and refunds read refundedAmount (falling back to total when absent).
 */
export function reportTotals(saleRows: readonly Order[], refundRows: readonly Order[]): ReportTotals {
  const t: ReportTotals = {
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  }
  for (const o of saleRows) {
    if (o.status !== 'completed' && o.status !== 'partially_refunded' && o.status !== 'refunded') continue
    t.gross += o.total
    t.grossCount += 1
    add(t.grossByPay, o.paymentMethod, o.total)
    if (o.status === 'completed' || o.status === 'partially_refunded') {
      const sold = stillSoldMoney(o)
      t.revenue += sold
      t.completedCount += 1
      add(t.byPay, o.paymentMethod, sold)
    }
  }
  for (const o of refundRows) {
    if (!isRefundedStatus(o.status)) continue
    const refunded = refundedMoney(o)
    t.refunds += refunded
    t.refundedCount += 1
    add(t.refundsByPay, o.paymentMethod, refunded)
  }
  t.net = t.gross - t.refunds
  return t
}
