import type { ListOrdersParams, ReportSummary } from '@mandalika/api'

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
  const methods = [...Object.keys(gross), ...Object.keys(refunds).filter((m) => !(m in gross))]
  return methods.map((method) => {
    const g = gross[method] ?? 0
    const r = refunds[method] ?? 0
    return { method, gross: g, refunds: r, net: g - r }
  })
}

/** Share of grossSales as a whole percent; 0 when there is no gross. */
export function sharePercent(part: number, gross: number): number {
  return gross > 0 ? Math.round((part / gross) * 100) : 0
}

/** The refund CSV pages the refund-day list: same filter, dateBasis=refund. */
export function refundExportParams(params: ListOrdersParams): ListOrdersParams {
  return { ...params, dateBasis: 'refund' }
}
