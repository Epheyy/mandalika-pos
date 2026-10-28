import type { components } from '@mandalika/api'
import { MAX_REFUND_REASON_CHARS, canRefund as userCanRefund, variantLabel } from '@mandalika/types'
import { formatRupiah } from './pricing'
import { PAYMENT_LABELS } from '../lib/paymentLabels'
import {
  buildRefundBasis, cacheHasRefunds, isExhausted, pickedUnits, refundAmountFor, remainingAmount, selectionToItems,
  type RefundCache, type RefundItemInput, type Selection,
} from './refundSelection'

// Re-exported so existing importers (localReceipts, panels) keep their import path.
export { PAYMENT_LABELS }

type Order = components['schemas']['Order']

// Pure rules behind the refund UI (A06, C4b): what the history panel offers, what CashierScreen
// queues, and how a parked refund reads in the review list. The gate is UI-only; the server decides.

export const REFUND_NO_PERMISSION = 'Butuh izin refund'
export const REFUND_QUEUED = 'Refund tersimpan di tablet'
export const REFUND_NO_SHIFT = 'Buka shift dulu'
export const REFUND_DONE = 'Sudah direfund'
export const REFUND_SHIFT_UNSYNCED = 'Shift masih tersimpan di tablet'
export const REFUND_CHANGED = 'Data refund berubah. Tutup lalu coba lagi.'
/** A struk without line data was already part-refunded from this tablet: only the history row knows what is left. */
export const REFUND_USE_HISTORY = 'Sebagian direfund · lanjutkan lewat Riwayat'

/** Info chip for an order that already had a per-line refund (shown beside the enabled button, never a block). */
export const refundPartialNote = (remaining: number | null): string =>
  remaining === null ? 'Sebagian direfund' : `Sebagian direfund · sisa ${formatRupiah(remaining)}`

export type RefundAvailability =
  | { kind: 'allowed'; note?: string }
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: string }

/** A sale made on this tablet, named by its client uuid (A41). The server id exists only once the sale synced. */
export interface LocalSaleRef {
  orderUuid: string
  serverOrderId?: string
}

/** What this tablet and the order row say about earlier per-line refunds (C4b). */
export interface PartialGate {
  /** Some units were refunded. */
  any: boolean
  /** Every unit is refunded: nothing is left to offer. */
  exhausted: boolean
  /** Money still refundable; null when it cannot be known (an order without line data). */
  remaining: number | null
  /** No line data to refund per line, yet this tablet already refunded part of it: a whole-order refund would pay twice. */
  wholeBlocked?: boolean
}

/** The partial-refund state of an order for the gate. An order without line data (pre-C4a) has none. */
export function partialGateFor(order: Order, cache: RefundCache = {}): PartialGate {
  const basis = buildRefundBasis(order, cache)
  if (basis.kind !== 'lines') {
    return cacheHasRefunds(cache) ? { any: true, exhausted: false, remaining: null, wholeBlocked: true } : { any: false, exhausted: false, remaining: null }
  }
  return {
    any: basis.priorAmount > 0 || basis.lines.some((l) => l.refundedQty > 0),
    exhausted: isExhausted(basis),
    remaining: remainingAmount(basis),
  }
}

export interface RefundAvailabilityInput {
  order: Pick<Order, 'id' | 'status'>
  canRefund: boolean
  /** A synced open shift exists: a refund pays out of that drawer (B3). */
  hasOpenShift: boolean
  /** The header shows a shift that has no server id yet (opened offline): its drawer cannot be attributed. */
  shiftUnsynced?: boolean
  /** Orders with a queued or parked (unacknowledged) refund on this device. */
  queuedOrderIds: ReadonlySet<string>
  /** Orders whose refund this tablet already saw acknowledged: a stale cached row may still say completed. */
  syncedRefundOrderIds?: ReadonlySet<string>
  /** The row is a local receipt: its uuid and (when known) server id are both its identity. */
  sale?: LocalSaleRef
  /** Sales (by uuid) with a queued or parked linked refund. */
  queuedSaleUuids?: ReadonlySet<string>
  /** Server id -> sale uuid for sales this tablet made, so a server history row matches a uuid refund. */
  serverIdToSaleUuid?: ReadonlyMap<string, string>
  /** Earlier per-line refunds of this order (C4b); absent = none known. */
  partial?: PartialGate
}

export function refundAvailability(i: RefundAvailabilityInput): RefundAvailability {
  if (i.order.status !== 'completed' && i.order.status !== 'partially_refunded') return { kind: 'hidden' }
  // Either id names the same sale: a refund may have been queued, or acknowledged, under the other one.
  const keys = [i.order.id, i.sale?.orderUuid, i.sale?.serverOrderId, i.serverIdToSaleUuid?.get(i.order.id)].filter((k): k is string => !!k)
  if (i.syncedRefundOrderIds && keys.some((k) => i.syncedRefundOrderIds!.has(k))) return { kind: 'blocked', reason: REFUND_DONE }
  if (i.partial?.exhausted) return { kind: 'blocked', reason: REFUND_DONE }
  if (i.partial?.wholeBlocked) return { kind: 'blocked', reason: REFUND_USE_HISTORY }
  if (!i.canRefund) return { kind: 'blocked', reason: REFUND_NO_PERMISSION }
  // D-44: while one refund of the order is queued here the order stays blocked, so the dialog never has to add up queued quantities.
  if (keys.some((k) => i.queuedOrderIds.has(k) || i.queuedSaleUuids?.has(k))) return { kind: 'blocked', reason: REFUND_QUEUED }
  if (!i.hasOpenShift) return { kind: 'blocked', reason: i.shiftUnsynced ? REFUND_SHIFT_UNSYNCED : REFUND_NO_SHIFT }
  if (i.order.status === 'partially_refunded' || i.partial?.any) return { kind: 'allowed', note: refundPartialNote(i.partial?.remaining ?? null) }
  return { kind: 'allowed' }
}

/** Same count the server applies: runes of the trimmed reason. */
export const canSubmitRefundReason = (reason: string): boolean => {
  const t = reason.trim()
  return t !== '' && [...t].length <= MAX_REFUND_REASON_CHARS
}

export interface RefundPayload {
  /** Server order id; '' for a sale that has not synced yet (then `saleOrderUuid` names it). */
  orderId: string
  /** The client uuid of a sale made on this tablet (A41). Absent on a refund of a server history row. */
  saleOrderUuid?: string
  reason: string
  /** C4b: the preset slug of the reason (D-43). */
  reasonCode?: string
  /** C4b per-line refund: the units returned, by position in the sale. ABSENT (never null) for a whole-order refund. */
  items?: RefundItemInput[]
  /** C4b: what the tablet pays out (a captured fact; the server flags a difference and caps it, D-49). Only with `items`. */
  refundAmount?: number
  // Display snapshot, written ONCE here and never touched again: the server fingerprints the
  // canonical payload per sync key and never reads these keys.
  orderNumber: string
  /** The order total for a whole-order refund; the refund amount for a per-line one (so an older bundle's recap shows what was paid out). */
  total: number
  paymentMethod: string
  /** The shift the sale belonged to (null when history did not say). */
  saleShiftId: string | null
}

export type PreparedRefund = { ok: true; payload: RefundPayload } | { ok: false; message: string }

export function prepareRefund(i: {
  order: Pick<Order, 'id' | 'orderNumber' | 'total' | 'paymentMethod' | 'shiftId'>
  reason: string
  /** The preset slug of the reason (D-43); omitted when the refund was made without chips. */
  reasonCode?: string
  /** Per-line refund: the validated lines and the amount to pay out. Absent = whole-order refund (legacy shape). */
  lines?: { items: RefundItemInput[]; amount: number }
  canRefund: boolean
  /** Server id of the open shift; '' = shown but not synced yet (cannot be attributed), null/undefined = none. */
  shiftId: string | null | undefined
  /** Set when the refund is of a sale made on this tablet (a local receipt). */
  sale?: LocalSaleRef
}): PreparedRefund {
  if (!i.canRefund) return { ok: false, message: REFUND_NO_PERMISSION }
  if (i.shiftId === '') return { ok: false, message: REFUND_SHIFT_UNSYNCED }
  if (!i.shiftId) return { ok: false, message: REFUND_NO_SHIFT }
  const reason = i.reason.trim()
  if (!canSubmitRefundReason(reason)) {
    return { ok: false, message: reason === '' ? 'Alasan refund wajib diisi' : `Alasan refund maksimal ${MAX_REFUND_REASON_CHARS} karakter` }
  }
  if (i.lines && (i.lines.items.length === 0 || !Number.isSafeInteger(i.lines.amount) || i.lines.amount < 0)) {
    return { ok: false, message: 'Pilih barang yang direfund' }
  }
  return {
    ok: true,
    payload: {
      orderId: i.sale ? (i.sale.serverOrderId ?? '') : i.order.id,
      ...(i.sale ? { saleOrderUuid: i.sale.orderUuid } : {}),
      reason,
      ...(i.reasonCode ? { reasonCode: i.reasonCode } : {}),
      ...(i.lines ? { items: i.lines.items.map((it) => ({ lineNo: it.lineNo, quantity: it.quantity })), refundAmount: i.lines.amount } : {}),
      orderNumber: i.order.orderNumber,
      total: i.lines ? i.lines.amount : i.order.total,
      paymentMethod: i.order.paymentMethod,
      saleShiftId: i.order.shiftId ?? null,
    },
  }
}

/** "BSD-G0007 · Rp 225.000 · Tunai" from a refund's captured snapshot (plus "2 barang" for a per-line refund);
 *  undefined for items queued before the snapshot existed (they render as before). */
export function refundDetail(payload: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!payload) return undefined
  const { orderNumber, total, paymentMethod } = payload
  if (typeof orderNumber !== 'string' || orderNumber === '' || typeof total !== 'number' || !Number.isFinite(total)) return undefined
  const method = typeof paymentMethod === 'string' && paymentMethod !== '' ? (PAYMENT_LABELS[paymentMethod] ?? paymentMethod) : null
  const units = Array.isArray(payload.items)
    ? (payload.items as { quantity?: unknown }[]).reduce((n, it) => n + (typeof it?.quantity === 'number' ? it.quantity : 0), 0)
    : 0
  return [orderNumber, formatRupiah(total), method, units > 0 ? `${units} barang` : null].filter((p) => p !== null).join(' · ')
}

export type RefundSubmitPlan =
  | { kind: 'enqueue'; payload: RefundPayload }
  | { kind: 'error'; message: string }

/** What handleRefundConfirm does: the dialog's order must be the one confirmed, and every guard passes,
 *  before anything is queued. The items and the amount are re-derived HERE from the order and the picked units
 *  (never taken from the screen), and a pick that no longer fits the order is refused, not trimmed. */
export function planRefundSubmit(i: {
  refundOrder: Order | null
  orderId: string
  reason: string
  reasonCode?: string
  /** The picked units (lineNo -> quantity); only read for an order that refunds per line. */
  selection?: Selection
  /** What this tablet knows about earlier refunds of the order. */
  cache?: RefundCache
  canRefund: boolean
  shiftId: string | null | undefined
  sale?: LocalSaleRef
}): RefundSubmitPlan {
  if (!i.refundOrder || i.refundOrder.id !== i.orderId) {
    return { kind: 'error', message: 'Transaksi refund tidak cocok. Tutup lalu coba lagi.' }
  }
  const basis = buildRefundBasis(i.refundOrder, i.cache)
  if (basis.kind === 'whole' && cacheHasRefunds(i.cache)) return { kind: 'error', message: REFUND_USE_HISTORY }
  let lines: { items: RefundItemInput[]; amount: number } | undefined
  if (basis.kind === 'lines') {
    const selection = i.selection ?? {}
    const items = selectionToItems(basis.lines, selection)
    if (pickedUnits(selection) === 0) return { kind: 'error', message: 'Pilih barang yang direfund' }
    // Every picked unit must survive the caps: a trimmed (or fully dropped) pick means the order changed under the dialog.
    if (items.reduce((n, it) => n + it.quantity, 0) !== pickedUnits(selection)) return { kind: 'error', message: REFUND_CHANGED }
    lines = { items, amount: refundAmountFor(basis, selection).amount }
  }
  const prepared = prepareRefund({ order: i.refundOrder, reason: i.reason, reasonCode: i.reasonCode, lines, canRefund: i.canRefund, shiftId: i.shiftId, sale: i.sale })
  return prepared.ok ? { kind: 'enqueue', payload: prepared.payload } : { kind: 'error', message: prepared.message }
}

/** The refund-related props CashierScreen hands the order history panel. */
export function refundGateProps(i: {
  user: Parameters<typeof userCanRefund>[0]
  currentShift: { id: string } | null | undefined
  queuedOrderIds: ReadonlySet<string>
  syncedRefundOrderIds?: ReadonlySet<string>
  queuedSaleUuids?: ReadonlySet<string>
  serverIdToSaleUuid?: ReadonlyMap<string, string>
  /** C4b: units and money this tablet saw acknowledged for an order named by any of these ids. */
  refundCache?: (ids: readonly string[]) => RefundCache
}) {
  return {
    canRefund: userCanRefund(i.user),
    hasOpenShift: !!i.currentShift?.id,
    shiftUnsynced: !!i.currentShift && !i.currentShift.id,
    queuedRefundOrderIds: i.queuedOrderIds,
    syncedRefundOrderIds: i.syncedRefundOrderIds,
    queuedSaleUuids: i.queuedSaleUuids,
    serverIdToSaleUuid: i.serverIdToSaleUuid,
    refundCache: i.refundCache,
  }
}

/** Every id that may name this order in the tablet's refund memory (server id, sale uuid, mapped uuid). */
export function refundOrderKeys(i: Pick<RefundAvailabilityInput, 'sale' | 'serverIdToSaleUuid'> & { order: Pick<Order, 'id'> }): string[] {
  return [i.order.id, i.sale?.orderUuid, i.sale?.serverOrderId, i.serverIdToSaleUuid?.get(i.order.id)].filter((k): k is string => !!k)
}

export interface RefundSummary {
  seq: number
  amount: number
  reason: string
  /** Lines returned in this refund, named from the order's own lines (a line the order no longer lists is shown by number). */
  lines: { name: string; quantity: number; amount: number }[]
}

/** The refunds of an order as the history shows them: "Refund ke-N", what was paid out, why, and which lines came back. */
export function refundSummaries(order: Pick<Order, 'items' | 'refunds'>): RefundSummary[] {
  const byLine = new Map<number, string>()
  for (const it of order.items ?? []) {
    if (typeof it.lineNo === 'number') byLine.set(it.lineNo, [it.productName, variantLabel(it.variantSize)].filter(Boolean).join(' '))
  }
  return [...(order.refunds ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({
      seq: r.seq,
      amount: r.amount,
      reason: r.reason,
      lines: (r.items ?? []).map((i) => ({
        name: typeof i.lineNo === 'number' ? (byLine.get(i.lineNo) ?? `Baris ${i.lineNo + 1}`) : 'Barang',
        quantity: i.quantity,
        amount: i.amount,
      })),
    }))
}
