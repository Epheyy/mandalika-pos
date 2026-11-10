import { fetchAllByCursor, fetchAllPages, type ListOrdersParams, type ListOrdersResult, type Order } from '@mandalika/api'
import { format, isValid, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

/** The slice of the API client an orders export needs. */
export interface OrdersExportApi {
  listOrders: (params?: ListOrdersParams) => Promise<ListOrdersResult>
}

/** An export and the server cut-off it is frozen at (null: read by offset paging, no cut-off). */
export interface OrderExport {
  rows: Order[]
  asOf: string | null
}

/**
 * Every order of a filter, in server order, via keyset pages of 1000 (fetchAllByCursor keeps the
 * A26 checks). An old backend that ignores paging=keyset is read with the offset pages instead,
 * and then has no cut-off. The cursor key is left out of the first request: the client would
 * otherwise send "undefined".
 */
export async function orderExportPager(api: OrdersExportApi, params: ListOrdersParams): Promise<OrderExport> {
  let asOf: string | null = null
  const rows = await fetchAllByCursor<Order>(
    (cursor, limit) =>
      api.listOrders({ ...params, paging: 'keyset', limit, ...(cursor ? { cursor } : {}) }),
    () => fetchAllPages((page, limit) => api.listOrders({ ...params, page, limit })),
    (cutoff) => { asOf = cutoff },
  )
  return { rows, asOf }
}

/** "Data s.d. 10 Nov 14:52": the server's cut-off of the export; null when there is none to show. */
export function exportCutoffLabel(asOf: string | null): string | null {
  if (!asOf) return null
  const d = parseISO(asOf)
  return isValid(d) ? `Data s.d. ${format(d, 'd MMM HH:mm', { locale: idLocale })}` : null
}
