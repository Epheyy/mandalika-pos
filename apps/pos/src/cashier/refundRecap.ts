import type { components } from '@mandalika/api'
import type { QueuedRefund } from '@mandalika/sync'

type Shift = components['schemas']['Shift']

// Shift recap vs refunds (A06). Drawer cash is what this shift's sales brought in, minus refunds
// paid out of THIS drawer for sales of OTHER shifts. Same-shift refunds are already out of
// `byMethod` (their orders are status "refunded"), so they are never subtracted again.

export interface RefundRecap {
  /** Per method: server-recorded + still-queued cross-shift refunds paid by this shift. */
  crossByMethod: Record<string, number>
  crossTotal: number
  /** Refunds stamped with this shift and parked for review: shown, never subtracted (the server never counted them). */
  parkedCount: number
  parkedTotal: number
  /** Queued refunds stamped with this shift but captured without the display snapshot: not in the math. */
  unknownDetailCount: number
}

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `queued` = unacknowledged refunds from the engine (acked ones are already in the server map).
 *  Omit it for a closed shift: its snapshot is final, late refunds never adjust it. */
export function refundRecap(shift: Shift | null, queued: readonly QueuedRefund[] | undefined): RefundRecap {
  const crossByMethod: Record<string, number> = {}
  for (const [m, v] of Object.entries(shift?.refundsPaidByMethod ?? {})) {
    const n = num(v)
    if (n !== null) crossByMethod[m] = n
  }
  let parkedCount = 0
  let parkedTotal = 0
  let unknownDetailCount = 0
  const shiftId = shift?.id ?? ''
  // A shift without a server id (offline-opened) stamps nothing, so nothing can belong to it.
  for (const r of shiftId === '' ? [] : (queued ?? [])) {
    if (r.shiftId !== shiftId) continue
    const total = num(r.payload.total)
    if (r.parked) {
      parkedCount += 1
      parkedTotal += total ?? 0
      continue
    }
    const method = r.payload.paymentMethod
    const saleShift = r.payload.saleShiftId
    // Key absent = captured before the snapshot (unknown). Present but null = the sale had no shift:
    // the server counts that as "other shift" too (shift_id IS DISTINCT FROM this one).
    if (total === null || typeof method !== 'string' || method === '' || !('saleShiftId' in r.payload) || (saleShift !== null && typeof saleShift !== 'string')) {
      unknownDetailCount += 1
      continue
    }
    if (saleShift === shiftId) continue // same-shift: leaves byMethod when it syncs
    crossByMethod[method] = (crossByMethod[method] ?? 0) + total
  }
  return { crossByMethod, crossTotal: sum(crossByMethod), parkedCount, parkedTotal, unknownDetailCount }
}

/** Recorded ("Tercatat") per method and in total, after refunds paid for other shifts. */
export function applyRefundRecap(byMethod: Record<string, number>, totalSales: number, rec: RefundRecap) {
  const out: Record<string, number> = { ...byMethod }
  for (const [m, v] of Object.entries(rec.crossByMethod)) out[m] = (out[m] ?? 0) - v
  return { byMethod: out, total: totalSales - rec.crossTotal }
}
