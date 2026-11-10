import { fetchAllByCursor, fetchAllPages, type ListOrdersParams, type ListOrdersResult, type Order } from '@mandalika/api'
import { format } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

/** The slice of the API client an orders export needs. */
export interface OrdersExportApi {
  listOrders: (params?: ListOrdersParams) => Promise<ListOrdersResult>
}

/**
 * Every order of a filter, in server order, via keyset pages of 1000 (fetchAllByCursor keeps the
 * A26 checks). An old backend that ignores paging=keyset is read with the offset pages instead.
 * The cursor key is left out of the first request: the client would otherwise send "undefined".
 */
export function orderExportPager(api: OrdersExportApi, params: ListOrdersParams): Promise<Order[]> {
  return fetchAllByCursor<Order>(
    (cursor, limit) =>
      api.listOrders({ ...params, paging: 'keyset', limit, ...(cursor ? { cursor } : {}) }),
    () => fetchAllPages((page, limit) => api.listOrders({ ...params, page, limit })),
  )
}

/** "Data s.d. 10 Nov 14:52": the moment the export started (browser clock), shown beside the download. */
export function exportCutoffLabel(startedAt: Date): string {
  return `Data s.d. ${format(startedAt, 'd MMM HH:mm', { locale: idLocale })}`
}
