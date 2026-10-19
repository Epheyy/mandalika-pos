// A28: order history is filtered by BUSINESS DAY (dateFrom/dateTo, the outlet-local opening day
// of the shift), not by UTC instants. The legacy `from`/`to` params stay on the server for old
// builds only. The cache key carries a `bd:` marker so entries cached under the old UTC-day
// key shape are never mistaken for business-day results (they just age out unread).
import { zoneParts } from './promoValidate'

export const PAGE_SIZE = 20

/** Today's business day (YYYY-MM-DD) on the outlet's clock; absent/unknown tz = Asia/Jakarta. */
export function businessToday(now: Date, timezone?: string | null): string {
  return zoneParts(now, timezone).dateStr
}

export function orderHistoryQuery(from: string, to: string, page: number, term: string): { qs: string; cacheKey: string } {
  const params: Record<string, string> = { dateFrom: from, dateTo: to, page: String(page), limit: String(PAGE_SIZE) }
  if (term) params.q = term
  return { qs: new URLSearchParams(params).toString(), cacheKey: `orders:bd:${from}:${to}:${page}:${term}` }
}
