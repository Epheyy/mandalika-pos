import type { ReportSummary } from '@mandalika/api'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { orderFilterParams, type OrderFilters } from './orderQuery'

/** The set of methods in a period hardly changes within a session: poll it slowly, not like the live totals. */
const HISTORY_POLL_MS = 300_000

/** Raw payment ids a summary reports (sales and refund lines). */
export function paymentIdsOf(s: Partial<Pick<ReportSummary, 'grossByPaymentMethod' | 'refundsByPaymentMethod'>> | null | undefined): string[] {
  return [...new Set([...Object.keys(s?.grossByPaymentMethod ?? {}), ...Object.keys(s?.refundsByPaymentMethod ?? {})])]
}

/**
 * Payment ids that exist in the same date range / outlet / status / search as the current view,
 * ignoring the payment filter itself, so a method removed from settings (or an old "cash") stays
 * selectable. Reuses /reports/summary (needs view_reports): no extra endpoint; with `enabled`
 * false the request is skipped and no ids are returned.
 */
export function useHistoricalPaymentIds(
  filters: OrderFilters,
  outletId: string | null | undefined,
  enabled: boolean,
): string[] {
  const params = orderFilterParams({ ...filters, payment: '' })
  const key = JSON.stringify(params)
  const q = usePolledQuery<ReportSummary | null>(
    () => (enabled ? api.reportSummary(params) : Promise.resolve(null)),
    [outletId, key, enabled],
    HISTORY_POLL_MS,
  )
  return paymentIdsOf(q.data)
}
