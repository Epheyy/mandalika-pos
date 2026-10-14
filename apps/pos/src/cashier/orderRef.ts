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

/** Highest SEQ among `orderNumbers` that carry device `code` ({OUTLET}-{CODE}{SEQ}); 0 if none.
 *  Codes are unique fleet-wide, so any outlet prefix is accepted. */
export function highestQueuedSeq(code: string, orderNumbers: readonly string[]): number {
  const re = new RegExp('^[A-Z0-9]+-' + code + '([0-9]+)$')
  let max = 0
  for (const n of orderNumbers) {
    const m = re.exec(n)
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0)
  }
  return max
}

/**
 * Format the next order number from the stored counter WITHOUT advancing it.
 * `boundOutletId` is the terminal's bound outlet: a device code registered for
 * another outlet is ignored. `queuedOrderNumbers` (numbers still in the outbox) raise
 * the counter floor, so a counter that was rolled back never re-issues a queued number.
 */
export function peekOrderNo(
  outletCode: string | null | undefined,
  deviceId: string,
  boundOutletId: string | null = null,
  kv: KV = getKV(),
  queuedOrderNumbers: readonly string[] = [],
): PeekedOrderNo {
  const code = readDeviceCode(kv, boundOutletId)
  const seqKey = code ? `${SEQ_KEY}.${code}` : SEQ_KEY
  const stored = parseInt(kv.get(seqKey) ?? '0', 10) || 0
  const next = (code ? Math.max(stored, highestQueuedSeq(code, queuedOrderNumbers)) : stored) + 1
  const dev = code ?? deviceTag(deviceId)
  return { orderNo: `${outletPart(outletCode)}-${dev}${String(next).padStart(4, '0')}`, seqKey, next }
}

/**
 * Take the next order number and write the counter before the sale is queued. Never
 * rejects and never blocks a sale: if the write fails the in-memory mirror is still
 * advanced and the error is returned for reporting.
 *
 * Guarantees: the counter write is awaited, and the number is above every number of this
 * device code still in the outbox (`queuedOrderNumbers`). Not guaranteed: on Android the
 * Preferences write resolves once it is handed to the OS (apply()), so a process kill right
 * after can roll the counter back; the outbox floor then covers every sale not yet acked.
 * A number whose sale was already acked and pruned is not covered; it stays safe only
 * because the counter write normally lands long before that.
 */
export async function reserveOrderNo(
  outletCode: string | null | undefined,
  deviceId: string,
  boundOutletId: string | null = null,
  kv: KV = getKV(),
  queuedOrderNumbers: readonly string[] = [],
): Promise<{ orderNo: string; error?: unknown }> {
  const { orderNo, seqKey, next } = peekOrderNo(outletCode, deviceId, boundOutletId, kv, queuedOrderNumbers)
  try {
    await kv.setDurable(seqKey, String(next))
    return { orderNo }
  } catch (error) {
    kv.set(seqKey, String(next))
    return { orderNo, error }
  }
}

/**
 * Legacy fallback — a stable 6-digit code hashed from the order uuid. Retained
 * for older receipts; new sales use {@link reserveOrderNo}.
 */
export function localOrderRef(orderUuid: string): string {
  let h = 0
  for (const ch of orderUuid.replace(/-/g, '')) {
    h = (h * 31 + parseInt(ch, 16) || 0) % 1_000_000
  }
  return `MND-${String(Math.abs(h)).padStart(6, '0')}`
}
