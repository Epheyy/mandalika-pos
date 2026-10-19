import type { ListOrdersParams, ReportSummaryParams } from '@mandalika/api'
import { format, subDays } from 'date-fns'

/** Filters shared by the order list, the report summary and the CSV export. */
export interface OrderFilters {
  /** YYYY-MM-DD, interpreted by the server as a WIB calendar day. '' = unbounded. */
  dateFrom: string
  dateTo: string
  status: string
  payment: string
  q: string
}

/** Query params for /orders and /reports/summary; empty filters are omitted. */
export function orderFilterParams(f: OrderFilters): ListOrdersParams & ReportSummaryParams {
  const p: ListOrdersParams & ReportSummaryParams = {}
  if (f.dateFrom) p.dateFrom = f.dateFrom
  if (f.dateTo) p.dateTo = f.dateTo
  // The UI only offers the contract's statuses; the server answers 400 otherwise.
  if (f.status) p.status = f.status as ListOrdersParams['status']
  if (f.payment.trim()) p.paymentMethod = f.payment.trim()
  if (f.q.trim()) p.q = f.q.trim()
  return p
}

/** Inclusive last-N-days window ending today (local calendar dates). */
export function lastDaysRange(days: number, now = new Date()): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: format(subDays(now, days - 1), 'yyyy-MM-dd'),
    dateTo: format(now, 'yyyy-MM-dd'),
  }
}
