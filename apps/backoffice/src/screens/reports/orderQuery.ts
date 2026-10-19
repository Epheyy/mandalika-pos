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

/** The server totals come from /reports/summary, which needs view_reports (admins pass). */
export function canViewSummary(isAdmin: boolean, permissions: readonly string[]): boolean {
  return isAdmin || permissions.includes('view_reports')
}

/**
 * Filters for the Transaksi tab. The date window (default last 30 days) is dropped
 * when "Semua tanggal" is ticked or when a search is typed, so search covers all dates.
 */
export function transaksiFilters(
  range: { dateFrom: string; dateTo: string },
  allDates: boolean,
  f: { status: string; payment: string; q: string },
): OrderFilters {
  const unbounded = allDates || f.q.trim() !== ''
  return {
    dateFrom: unbounded ? '' : range.dateFrom,
    dateTo: unbounded ? '' : range.dateTo,
    status: f.status,
    payment: f.payment,
    q: f.q,
  }
}

/** Header text; a count or total that is not loaded (or not allowed) shows a dash, never 0. */
export function transaksiHeader(total: number | undefined, sales: number | undefined, formatMoney: (n: number) => string): string {
  const count = total === undefined ? '–' : String(total)
  const money = sales === undefined ? '–' : formatMoney(sales)
  return `${count} transaksi · Total: ${money}`
}
