import type { Api, CrossOutletOrder } from '@mandalika/api'

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
export async function lookupCrossOutlet(api: Pick<Api, 'crossOutletLookup'>, text: string): Promise<CrossOutletOrder[]> {
  const q = lookupQuery(text)
  if (!q) return []
  return api.crossOutletLookup(q)
}

export const CROSS_OFFLINE_SEARCH = 'Butuh internet'
