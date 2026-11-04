import type { ListOrdersParams, Order, ReportSummary } from '@mandalika/api'
import { isRefundedStatus, refundedMoney } from './reportTotals'
import { canonicalMethodCode } from '../../lib/paymentLabel'

export interface RefundCsvFields {
  /** Money refunded on the order; '' for an order that is not refunded. */
  amount: number | ''
  refundedAt: string | null | undefined
  refundBusinessDate: string | null | undefined
  reason: string
}

/**
 * Refund columns of the order CSV (C4a). A partially refunded order has NULL order-level refund
 * columns, so they fall back to the latest refunds[] entry; an older backend (no refunds[]) keeps
 * the order-level values unchanged. The per-refund CSV is slice C4c.
 */
export function refundCsvFields(o: Order): RefundCsvFields {
  const last = o.refunds && o.refunds.length > 0 ? o.refunds[o.refunds.length - 1] : undefined
  return {
    amount: isRefundedStatus(o.status) ? refundedMoney(o) : '',
    refundedAt: o.refundedAt ?? last?.refundedAt,
    refundBusinessDate: o.refundBusinessDate ?? last?.refundBusinessDate,
    reason: o.refundReason || last?.reason || '',
  }
}

/** A money figure the server may not have sent (backend not yet deployed): a dash, never 0. */
export function moneyOrDash(n: number | undefined, format: (n: number) => string): string {
  return n === undefined ? '–' : format(n)
}

/**
 * An older backend always sends totalRefunds but ignores dateBasis and has no grossSales, so the
 * refund figures are only trustworthy when grossSales is present.
 */
export function hasRefundBasis(s: Pick<ReportSummary, 'grossSales'> | null | undefined): boolean {
  return !!s && s.grossSales !== undefined
}

/** The refund CSV is pointless (a silent no-op) without a refund-day basis or refunds to export. */
export function canExportRefunds(s: Pick<ReportSummary, 'grossSales' | 'refundedOrders'> | null | undefined): boolean {
  return hasRefundBasis(s) && (s?.refundedOrders ?? 0) > 0
}

/** Net is red when negative (a refund day can exceed its sales). */
export function isNegative(n: number | undefined): boolean {
  return n !== undefined && n < 0
}

export interface BreakdownRow {
  method: string
  gross: number
  refunds: number
  net: number
}

/**
 * Payment breakdown (A27): per raw payment method, gross by sale day, refunds by refund day (grouped
 * by the ORIGINAL method) and net = gross - refunds. Methods are the union of both maps, in first-seen
 * order (gross first). Empty when the server sent neither map.
 */
export function breakdownRows(s: Partial<Pick<ReportSummary, 'grossByPaymentMethod' | 'refundsByPaymentMethod'>>): BreakdownRow[] {
  const gross = s.grossByPaymentMethod ?? {}
  const refunds = s.refundsByPaymentMethod ?? {}
  // Grouped by canonical code so "Cash"/"cash"/"tunai" are one card (as on the dashboard), first-seen order.
  const rows = new Map<string, BreakdownRow>()
  const add = (raw: string, g: number, r: number) => {
    const method = canonicalMethodCode(raw)
    const cur = rows.get(method) ?? { method, gross: 0, refunds: 0, net: 0 }
    const gross2 = cur.gross + g
    const refunds2 = cur.refunds + r
    rows.set(method, { method, gross: gross2, refunds: refunds2, net: gross2 - refunds2 })
  }
  for (const m of Object.keys(gross)) add(m, gross[m] ?? 0, 0)
  for (const m of Object.keys(refunds)) add(m, 0, refunds[m] ?? 0)
  return [...rows.values()]
}

/** Share of grossSales as a whole percent; 0 when there is no gross. */
export function sharePercent(part: number, gross: number): number {
  return gross > 0 ? Math.round((part / gross) * 100) : 0
}

/** The refund CSV pages the refund-day list: same filter, dateBasis=refund. */
export function refundExportParams(params: ListOrdersParams): ListOrdersParams {
  return { ...params, dateBasis: 'refund' }
}
