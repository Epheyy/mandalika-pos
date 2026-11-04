import { ApiError, fetchAllPages, type Api, type DashboardAggregate, type ListOrdersParams, type Order, type Promotion } from '@mandalika/api'
import { dashboardAggregateParams, viewFromAggregate, viewFromOrders, type DashboardView } from './dashboardView'
import { dashboardFetchWindow, refundSideOrNull, type Period } from './metrics'

/** What one poll returned: the server aggregate, or (older backend) the full order lists to compute from. */
export type DashboardData =
  | { kind: 'aggregate'; now: Date; agg: DashboardAggregate }
  | { kind: 'orders'; now: Date; sale: Order[]; refund: Order[] | null }

/** After a 404/405 the aggregate route is assumed missing for this long, then probed again (a backend deployed mid-session). */
export const AGGREGATE_REPROBE_MS = 5 * 60_000

/** Per-tab memory of "the backend has no aggregate route yet"; module scope so a remount does not re-probe on every poll. */
const unsupported = { until: 0 }

/** Test hook: forget a remembered 404. */
export function resetAggregateProbe(): void {
  unsupported.until = 0
}

const isAggregate = (v: unknown): v is DashboardAggregate => {
  const a = v as Partial<DashboardAggregate> | null | undefined
  const obj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)
  return (
    !!a && obj(a.current) && Array.isArray(a.trend) && Array.isArray(a.topProducts) && Array.isArray(a.bottomProducts) &&
    Array.isArray(a.cashiers) && Array.isArray(a.promoTally) && obj(a.grossByPaymentMethod) && obj(a.refundsByPaymentMethod) &&
    typeof a.distinctProducts === 'number'
  )
}

type DashboardApi = Pick<Api, 'reportDashboard' | 'listOrders'>

/** Today's fetch: the sale side without a status filter plus the refund side (A27); an old backend maps the refund side to null. */
async function fetchOrderLists(api: DashboardApi, period: Period, now: Date): Promise<DashboardData> {
  const w = dashboardFetchWindow(period, now)
  const params: ListOrdersParams = {}
  if (w.dateFrom) params.dateFrom = w.dateFrom
  if (w.dateTo) params.dateTo = w.dateTo
  const [sale, refund] = await Promise.all([
    fetchAllPages((page, limit) => api.listOrders({ ...params, page, limit })),
    // A request failure is NOT swallowed (keeps the previous data / shows the error); only an
    // unsupported response (old backend) maps to null via refundSideOrNull.
    fetchAllPages((page, limit) => api.listOrders({ ...params, dateBasis: 'refund', page, limit })).then(refundSideOrNull),
  ])
  return { kind: 'orders', now, sale, refund }
}

/**
 * One Ringkasan poll. Prefers the server aggregate (one small request). Only a 404/405 (route missing: older
 * backend) falls back to the client computation over the full order lists; every other failure is rethrown so
 * the screen keeps its previous numbers and shows the error. `now` is read once: the windows, the trend
 * skeleton and the numbers all belong to the same instant.
 */
export async function fetchDashboard(api: DashboardApi, period: Period, nowMs: number = Date.now()): Promise<DashboardData> {
  const now = new Date(nowMs)
  if (nowMs >= unsupported.until) {
    try {
      const agg = await api.reportDashboard(dashboardAggregateParams(period, now))
      // A 200 that is not the aggregate (a proxy or an unknown route answering generically) is "no route" too.
      if (isAggregate(agg)) return { kind: 'aggregate', now, agg }
      unsupported.until = nowMs + AGGREGATE_REPROBE_MS
    } catch (e) {
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e
      unsupported.until = nowMs + AGGREGATE_REPROBE_MS
    }
  }
  return fetchOrderLists(api, period, now)
}

/** The numbers Ringkasan renders for one poll's data. */
export function dashboardView(data: DashboardData, period: Period, promotions: readonly Promotion[]): DashboardView {
  return data.kind === 'aggregate'
    ? viewFromAggregate(data.agg, period, data.now, promotions)
    : viewFromOrders(data.sale, data.refund, period, data.now, promotions)
}
