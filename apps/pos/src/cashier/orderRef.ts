// Client-authoritative order number, shown on the success screen + printed
// receipt AND sent to the server as the canonical order_number, so the receipt
// and the transaction history always match.
//
// Format: {OUTLET}-{DEV}{SEQ}  e.g.  JKT-A0042
//   OUTLET — assigned outlet code (from the sync snapshot); 'OUT' if unknown.
//   DEV    — 1 base36 char derived from the deviceId; disambiguates multiple
//            tablets in one outlet so their numbers never collide offline.
//   SEQ    — per-device monotonic counter in durable storage (survives reload).
// The hard uniqueness key remains order_uuid (idempotency = deviceId:orderUuid),
// so even a cosmetic number clash can never corrupt data or fail a flush.

import { getKV } from '@mandalika/sync'

const SEQ_KEY = 'mandalika.pos.orderSeq'

/** Stable 1-char base36 device tag from the deviceId. */
function deviceTag(deviceId: string): string {
  let h = 0
  for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (h % 36).toString(36).toUpperCase()
}

/** Sanitise an outlet code to A–Z0–9, max 4 chars. */
function outletPart(code: string | null | undefined): string {
  const c = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
  return c || 'OUT'
}

/**
 * Generate the next client-authoritative order number and advance the durable
 * per-device counter. Call exactly once per completed sale.
 */
export function nextOrderNo(outletCode: string | null | undefined, deviceId: string): string {
  const kv = getKV()
  const next = (parseInt(kv.get(SEQ_KEY) ?? '0', 10) || 0) + 1
  kv.set(SEQ_KEY, String(next))
  return `${outletPart(outletCode)}-${deviceTag(deviceId)}${String(next).padStart(4, '0')}`
}

/**
 * Legacy fallback — a stable 6-digit code hashed from the order uuid. Retained
 * for older receipts; new sales use {@link nextOrderNo}.
 */
export function localOrderRef(orderUuid: string): string {
  let h = 0
  for (const ch of orderUuid.replace(/-/g, '')) {
    h = (h * 31 + parseInt(ch, 16) || 0) % 1_000_000
  }
  return `MND-${String(Math.abs(h)).padStart(6, '0')}`
}
