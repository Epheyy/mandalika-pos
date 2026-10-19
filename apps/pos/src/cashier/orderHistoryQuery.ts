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

/**
 * The day the history opens on. A sale belongs to its SHIFT's opening day, so with a shift open
 * the default is that day (a sale after midnight on a shift opened yesterday still shows);
 * otherwise the outlet-zone today. An unparseable openedAt is ignored.
 */
export function defaultHistoryDay(now: Date, timezone?: string | null, shiftOpenedAt?: string | null): string {
  if (shiftOpenedAt) {
    const opened = new Date(shiftOpenedAt)
    if (!Number.isNaN(opened.getTime())) return zoneParts(opened, timezone).dateStr
  }
  return businessToday(now, timezone)
}

/** `cacheKey` is null for a search: what the cashier typed (a phone or a name) is never written into storage, in a key or
 *  through the rows it returns (A30). Only the plain day listing is cached. */
export function orderHistoryQuery(from: string, to: string, page: number, term: string): { qs: string; cacheKey: string | null } {
  const params: Record<string, string> = { dateFrom: from, dateTo: to, page: String(page), limit: String(PAGE_SIZE) }
  if (term) params.q = term
  return { qs: new URLSearchParams(params).toString(), cacheKey: term ? null : `orders:bd:${from}:${to}:${page}:` }
}
