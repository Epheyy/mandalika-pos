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
): { summary: PolledQuery<ReportSummary>; list: PolledQuery<ListResult<Order>> } {
  const params = orderFilterParams(filters)
  const key = JSON.stringify(params)
  const summary = usePolledQuery<ReportSummary>(() => api.reportSummary(params), [outletId, key])
  const list = usePolledQuery<ListResult<Order>>(
    () => api.listOrders({ ...params, page, limit: pageSize }),
    [outletId, key, page, pageSize],
  )
  return { summary, list }
}
