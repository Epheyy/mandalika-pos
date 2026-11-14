import type { components } from '@mandalika/api'
import type { QueuedVoid } from '@mandalika/sync'
import { VOID_REASONS } from './voidRules'

type Order = components['schemas']['Order']

// Shift recap vs voids (Void phase 3). The recap's figures come from the SERVER's orders of the shift, so:
//  - a synced void is already out of them (aggregate skips `cancelled`) and its replacement is already in them;
//  - a void still in the outbox is not, so the overlay takes the original's applied tenders out and puts the
//    replacement's in. Unsynced sales are never part of the recap, so a void whose sale is itself still in the
//    outbox (orderId '') changes nothing here.
// A replacement is forced into the ORIGINAL's shift by the server: a void of a closed shift's sale never touches
// today's drawer (only a void whose originalShiftId is the recap's shift is overlaid).

export type VoidFollowup = 'diganti' | 'menunggu pengganti' | 'tanpa pengganti'

export interface VoidRecapRow {
  orderNumber: string
  total: number
  reasonLabel: string
  voidedBy: string
  replacementNumber?: string
  state: 'synced' | 'queued' | 'review'
  /** Copy for the replacement state (an addition to the planned shape, so the list needs no second lookup). */
  followup: VoidFollowup
}

const reasonLabelOf = (code: string): string => VOID_REASONS.find((r) => r.code === code)?.label ?? code
const sumTenders = (t: readonly { amount: number }[]): number => t.reduce((a, x) => a + x.amount, 0)

/** Cancelled orders of this shift that carry `void` (fsmigrate-imported cancelled orders have none and are not
 *  listed), plus unacknowledged voids of this shift's sales; one row per order. */
export function voidRecapRows(orders: Order[], queued: QueuedVoid[], shiftId: string): VoidRecapRow[] {
  const rows: VoidRecapRow[] = []
  const seen = new Set<string>()
  for (const o of orders) {
    if (o.status !== 'cancelled' || !o.void || o.shiftId !== shiftId) continue
    seen.add(o.id)
    const replacementNumber = o.void.replacementOrderNumber
    const followup: VoidFollowup = replacementNumber ? 'diganti'
      : o.void.mode === 'later' && o.void.followup !== 'no_replacement' ? 'menunggu pengganti' : 'tanpa pengganti'
    rows.push({
      orderNumber: o.orderNumber, total: o.total, reasonLabel: reasonLabelOf(o.void.reasonCode), voidedBy: o.void.voidedByName ?? '',
      ...(replacementNumber ? { replacementNumber } : {}), state: 'synced', followup,
    })
  }
  const byId = new Map(orders.map((o) => [o.id, o]))
  for (const v of queued) {
    if (v.originalShiftId !== shiftId) continue
    const key = v.orderId || v.saleOrderUuid || v.idempotencyKey
    if (seen.has(key)) continue
    seen.add(key)
    const o = v.orderId ? byId.get(v.orderId) : undefined
    rows.push({
      orderNumber: o?.orderNumber ?? '—', total: o?.total ?? sumTenders(v.originalTenders), reasonLabel: '', voidedBy: '',
      state: v.parked ? 'review' : 'queued', followup: v.mode === 'replace' ? 'menunggu pengganti' : 'tanpa pengganti',
    })
  }
  return rows
}

/** False for a "Buat pengganti" order that belongs to another shift: it is not in today's drawer. Ordinary
 *  orders are not judged here (the server already scoped them to the shift). */
export function inRecapShift(o: { shiftId?: string | null; replacesOrderId?: string }, shiftId: string): boolean {
  return !o.replacesOrderId || o.shiftId === shiftId
}

export interface VoidRecapOverlay {
  byMethod: Record<string, number>
  total: number
  /** Signed change to the order count: -1 for a void without replacement, 0 with one. */
  orders: number
}

export function voidRecapOverlay(queued: QueuedVoid[], orders: Order[], shiftId: string): VoidRecapOverlay {
  const byMethod: Record<string, number> = {}
  let total = 0
  let count = 0
  const add = (m: string, v: number) => { byMethod[m] = (byMethod[m] ?? 0) + v; total += v }
  const byId = new Map(orders.map((o) => [o.id, o]))
  for (const v of queued) {
    if (v.parked || v.originalShiftId !== shiftId || v.orderId === '') continue
    if (byId.get(v.orderId)?.status === 'cancelled') continue // the server data already reflects this void
    for (const t of v.originalTenders) add(t.method, -t.amount)
    const hasReplacement = v.mode === 'replace' && (v.replacementTenders?.length ?? 0) > 0
    // The replacement commits with the void, so it is normally absent from the server's orders; if it is
    // listed anyway it is already in byMethod.
    const replacementListed = orders.some((o) => o.replacesOrderId === v.orderId)
    const addsReplacement = hasReplacement && !replacementListed
    if (addsReplacement) for (const t of v.replacementTenders ?? []) add(t.method, t.amount)
    if (!addsReplacement) count -= 1
  }
  return { byMethod, total, orders: count }
}

export function applyVoidRecap(byMethod: Record<string, number>, totalSales: number, ov: VoidRecapOverlay) {
  const out: Record<string, number> = { ...byMethod }
  for (const [k, v] of Object.entries(ov.byMethod)) out[k] = (out[k] ?? 0) + v
  return { byMethod: out, totalSales: totalSales + ov.total }
}
