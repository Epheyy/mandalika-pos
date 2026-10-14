// Client-authoritative order number, shown on the success screen + printed
// receipt AND sent to the server as the canonical order_number, so the receipt
// and the transaction history always match.
//
// Format: {OUTLET}-{DEV}{SEQ}  e.g.  JKT-AA0042
//   OUTLET — assigned outlet code (from the sync snapshot); 'OUT' if unknown.
//   DEV    — the server-assigned device code at this outlet (2+ letters, never
//            reused; see deviceCode.ts). Until the tablet has one it falls back to
//            the legacy 1 base36 char hashed from the deviceId (e.g. JKT-A0042),
//            which can never equal a coded number.
//   SEQ    — monotonic counter in durable storage (survives reload), one per
//            device code; the legacy counter is used only in the fallback.
// The hard uniqueness key remains order_uuid (idempotency = deviceId:orderUuid),
// so even a cosmetic number clash can never corrupt data or fail a flush.

import { getKV, type KV } from '@mandalika/sync'
import { readDeviceCode } from './deviceCode'

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

export interface PeekedOrderNo {
  orderNo: string
  /** KV key of the counter this number draws from. */
  seqKey: string
  /** The counter value this number uses (the value to store). */
  next: number
}

/**
 * Format the next order number from the stored counter WITHOUT advancing it.
 * `boundOutletId` is the terminal's bound outlet: a device code registered for
 * another outlet is ignored.
 */
export function peekOrderNo(
  outletCode: string | null | undefined,
  deviceId: string,
  boundOutletId: string | null = null,
  kv: KV = getKV(),
): PeekedOrderNo {
  const code = readDeviceCode(kv, boundOutletId)
  const seqKey = code ? `${SEQ_KEY}.${code}` : SEQ_KEY
  const next = (parseInt(kv.get(seqKey) ?? '0', 10) || 0) + 1
  const dev = code ?? deviceTag(deviceId)
  return { orderNo: `${outletPart(outletCode)}-${dev}${String(next).padStart(4, '0')}`, seqKey, next }
}

/**
 * Take the next order number and make the counter durable BEFORE the sale is queued, so a
 * kill right after a journaled sale cannot hand the same number out again. Never rejects and
 * never blocks a sale: if the durable write fails the in-memory mirror is still advanced and
 * the error is returned for reporting.
 */
export async function reserveOrderNo(
  outletCode: string | null | undefined,
  deviceId: string,
  boundOutletId: string | null = null,
  kv: KV = getKV(),
): Promise<{ orderNo: string; error?: unknown }> {
  const { orderNo, seqKey, next } = peekOrderNo(outletCode, deviceId, boundOutletId, kv)
  try {
    await kv.setDurable(seqKey, String(next))
    return { orderNo }
  } catch (error) {
    kv.set(seqKey, String(next))
    return { orderNo, error }
  }
}

/**
 * Synchronous variant: advance the (non-durable) counter and return the number.
 * The cashier uses {@link reserveOrderNo}; this stays for callers that cannot await.
 */
export function nextOrderNo(
  outletCode: string | null | undefined,
  deviceId: string,
  boundOutletId: string | null = null,
  kv: KV = getKV(),
): string {
  const { orderNo, seqKey, next } = peekOrderNo(outletCode, deviceId, boundOutletId, kv)
  kv.set(seqKey, String(next))
  return orderNo
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
