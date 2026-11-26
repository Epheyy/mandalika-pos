import { ApiError, type Api, type CrossOutletOrder } from '@mandalika/api'

/** Only digits and the usual phone punctuation = a phone number; anything else is an order number (A18). */
const PHONE_SHAPE = /^[\d\s+\-()]+$/

export type LookupQuery = { phone: string } | { orderNumber: string }

/** The exact-match query for what the cashier typed, or null for blank input. Never a partial search (A30). */
export function lookupQuery(text: string): LookupQuery | null {
  const t = text.trim()
  if (!t) return null
  return PHONE_SHAPE.test(t) && /\d/.test(t) ? { phone: t } : { orderNumber: t }
}

/** Looks up another outlet's sales. Online only; the answer is returned, never cached or written to storage (A30). */
export async function lookupCrossOutlet(api: Pick<Api, 'crossOutletLookup'>, text: string, deviceId?: string): Promise<CrossOutletOrder[]> {
  const q = lookupQuery(text)
  if (!q) return []
  return api.crossOutletLookup(deviceId ? { ...q, deviceId } : q)
}

/** What the cashier sees when a lookup fails. A 429 is the per-user budget (A18): the wait comes from Retry-After. */
export function lookupErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) {
    if (!e.retryAfterMs) return 'Terlalu banyak pencarian. Coba lagi nanti.'
    return `Terlalu banyak pencarian. Coba lagi dalam ${Math.max(1, Math.ceil(e.retryAfterMs / 60000))} menit.`
  }
  return e instanceof Error ? e.message : 'Gagal mencari transaksi'
}

export const CROSS_OFFLINE_SEARCH = 'Butuh internet'
