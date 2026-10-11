import { fetchAllPages, type Api, type components } from '@mandalika/api'
import { cacheRead, cacheWrite } from '../lib/offlineCache'

type S = components['schemas']
type Client = Pick<Api, 'request'>
export const RECAP_STALE_NOTICE = 'Data belum diperbarui — menampilkan snapshot lengkap terakhir'

export function recapOrders(api: Client, shiftId: string) {
  return fetchAllPages((page, limit) => api.request<S['OrderListResponse']>(
    'GET', `/api/v1/orders?shiftId=${encodeURIComponent(shiftId)}&page=${page}&limit=${limit}`,
  ))
}

export function recapFlows(api: Client, shiftId: string) {
  return fetchAllPages((page, limit) => api.request<S['CashFlowListResponse']>(
    'GET', `/api/v1/cash-flows?shiftId=${encodeURIComponent(shiftId)}&page=${page}&limit=${limit}`,
  ))
}

/** Cache one whole cohort only after every constituent request succeeds.
 * Legacy unmarked snapshots may contain truncated data: retain their bytes, but
 * do not present them as complete. This cache is not the financial journal.
 */
export async function completeRecap<T>(key: string, fetcher: () => Promise<T>) {
  try {
    const data = await fetcher()
    cacheWrite(key, { completePagination: 1, data })
    return { data, stale: false }
  } catch (error) {
    const cached = cacheRead<{ completePagination?: number; data: T }>(key)
    if (cached?.completePagination === 1) return { data: cached.data, stale: true }
    throw error
  }
}

export const loadCurrentRecap = (api: Client) => completeRecap('rekap:current', async () => {
  const { data: shift } = await api.request<S['ShiftResponse']>('GET', '/api/v1/shifts/current')
  const [orders, flows] = shift ? await Promise.all([recapOrders(api, shift.id), recapFlows(api, shift.id)]) : [[], []]
  return { shift: shift ?? null, orders, flows }
})

/** Like loadCurrentRecap, but a fallback to the cached snapshot is a failure: a refresh that is meant to
 *  pick up newer server state must never "succeed" with the old data. */
export async function freshCurrentRecap(api: Client) {
  const r = await loadCurrentRecap(api)
  if (r.stale) throw new Error(RECAP_STALE_NOTICE)
  return r.data
}

export const loadRecapHistory = (api: Client) => completeRecap('rekap:history', () =>
  fetchAllPages((page, limit) => api.request<S['ShiftListResponse']>('GET', `/api/v1/shifts?page=${page}&limit=${limit}`)),
)

export const loadHistoricalRecap = (api: Client, shiftId: string) => completeRecap(`rekap:orders:${shiftId}`, async () => {
  const [orders, flows] = await Promise.all([recapOrders(api, shiftId), recapFlows(api, shiftId)])
  return { orders, flows }
})
