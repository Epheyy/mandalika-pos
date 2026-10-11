import type { components } from '@mandalika/api'
import type { QueuedRefund } from '@mandalika/sync'

type Shift = components['schemas']['Shift']
type Order = components['schemas']['Order']
export type RecapOrder = Pick<Order, 'id' | 'status' | 'total' | 'paymentMethod'>

// Shift recap vs refunds (A06). Drawer cash is what this shift's sales brought in, minus refunds
// paid out of THIS drawer. `byMethod` comes from the shift's completed orders on the server, so a
// refund is already out of it once its order is refunded there; a refund that is only queued is not.

export interface RefundRecap {
  /** Per method: server-recorded + still-queued refunds of OTHER shifts' sales paid by this shift. */
  crossByMethod: Record<string, number>
  crossTotal: number
  /** Queued refunds of THIS shift's own sales whose order is still completed in the loaded orders. */
  ownPendingByMethod: Record<string, number>
  ownPendingTotal: number
  /** Refunds stamped with this shift and parked for review: shown, never subtracted (the server never counted them). */
  parkedCount: number
  parkedTotal: number
  /** Queued refunds stamped with this shift, order not loaded, captured without the display snapshot: not in the math. */
  unknownDetailCount: number
}

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const add = (m: Record<string, number>, k: string, v: number) => { m[k] = (m[k] ?? 0) + v }

/** `queued` = unacknowledged refunds from the engine (acked ones are already in the server map).
 *  `orders` = this shift's loaded orders (the same set `byMethod` was built from); omit for a closed
 *  shift together with `queued`: its snapshot is final, late refunds never adjust it. */
export function refundRecap(
  shift: Shift | null,
  queued: readonly QueuedRefund[] | undefined,
  orders?: readonly RecapOrder[] | null,
): RefundRecap {
  const crossByMethod: Record<string, number> = {}
  for (const [m, v] of Object.entries(shift?.refundsPaidByMethod ?? {})) {
    const n = num(v)
    if (n !== null) crossByMethod[m] = n
  }
  const ownPendingByMethod: Record<string, number> = {}
  let parkedCount = 0
  let parkedTotal = 0
  let unknownDetailCount = 0
  const shiftId = shift?.id ?? ''
  const byId = new Map((orders ?? []).map((o) => [o.id, o]))
  // A shift without a server id (offline-opened) stamps nothing, so nothing can belong to it.
  for (const r of shiftId === '' ? [] : (queued ?? [])) {
    if (r.shiftId !== shiftId) continue
    const total = num(r.payload.total)
    if (r.parked) {
      parkedCount += 1
      parkedTotal += total ?? 0
      continue
    }
    const loaded = byId.get(r.orderId)
    if (loaded) {
      // Server truth: still completed = still in byMethod, take it out; refunded = already out.
      if (loaded.status === 'completed') add(ownPendingByMethod, loaded.paymentMethod, loaded.total)
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
    if (saleShift === shiftId) continue // own sale not in the loaded set: not in byMethod either
    add(crossByMethod, method, total)
  }
  return {
    crossByMethod, crossTotal: sum(crossByMethod),
    ownPendingByMethod, ownPendingTotal: sum(ownPendingByMethod),
    parkedCount, parkedTotal, unknownDetailCount,
  }
}

/** Recorded ("Tercatat") per method and in total, after refunds paid out of this drawer. */
export function applyRefundRecap(byMethod: Record<string, number>, totalSales: number, rec: RefundRecap) {
  const out: Record<string, number> = { ...byMethod }
  for (const m of [rec.crossByMethod, rec.ownPendingByMethod]) {
    for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) - v
  }
  return { byMethod: out, total: totalSales - rec.crossTotal - rec.ownPendingTotal }
}

/** The figures the recap screen, its totals and the printed slip all use. */
export function recapFigures(
  live: { byMethod: Record<string, number>; totalSales: number },
  shift: Shift | null,
  queued: readonly QueuedRefund[] | undefined,
  orders: readonly RecapOrder[] | null | undefined,
) {
  const rec = refundRecap(shift, queued, orders)
  return { rec, ...applyRefundRecap(live.byMethod, live.totalSales, rec) }
}
