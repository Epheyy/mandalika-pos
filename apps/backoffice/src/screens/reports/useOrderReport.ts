import type { ListResult, Order, ReportSummary } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery, type PolledQuery } from '../../hooks/usePolledQuery'
import { orderFilterParams, type OrderFilters } from './orderQuery'

/**
 * Server-side totals plus one page of the matching orders. Both requests carry the
 * same filter, and the backend builds them from one shared WHERE clause, so the
 * totals always cover exactly the rows the list (and a full CSV export) pages over.
 */
export function useOrderReport(
  filters: OrderFilters,
  page: number,
  pageSize: number,
  outletId: string | null | undefined,
  withSummary = true,
): { summary: PolledQuery<ReportSummary | null>; list: PolledQuery<ListResult<Order>> } {
  const params = orderFilterParams(filters)
  const key = JSON.stringify(params)
  // /reports/summary needs view_reports; callers without it skip the request (data stays null).
  const summary = usePolledQuery<ReportSummary | null>(
    () => (withSummary ? api.reportSummary(params) : Promise.resolve(null)),
    [outletId, key, withSummary],
  )
  const list = usePolledQuery<ListResult<Order>>(
    () => api.listOrders({ ...params, page, limit: pageSize }),
    [outletId, key, page, pageSize],
  )
  return { summary, list }
}
