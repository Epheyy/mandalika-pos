import type { components } from '@mandalika/api'
import { MAX_REFUND_REASON_CHARS, canRefund as userCanRefund } from '@mandalika/types'
import { formatRupiah } from './pricing'
import { PAYMENT_LABELS } from '../lib/paymentLabels'

// Re-exported so existing importers (localReceipts, panels) keep their import path.
export { PAYMENT_LABELS }

type Order = components['schemas']['Order']

// Pure rules behind the refund UI (A06): what the history panel offers, what CashierScreen
// queues, and how a parked refund reads in the review list. The gate is UI-only; the server decides.

export const REFUND_NO_PERMISSION = 'Butuh izin refund'
export const REFUND_QUEUED = 'Refund tersimpan di tablet'
export const REFUND_NO_SHIFT = 'Buka shift dulu'
export const REFUND_DONE = 'Sudah direfund'
export const REFUND_SHIFT_UNSYNCED = 'Shift masih tersimpan di tablet'

export type RefundAvailability =
  | { kind: 'allowed' }
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: string }

/** A sale made on this tablet, named by its client uuid (A41). The server id exists only once the sale synced. */
export interface LocalSaleRef {
  orderUuid: string
  serverOrderId?: string
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
}

export function refundAvailability(i: RefundAvailabilityInput): RefundAvailability {
  if (i.order.status !== 'completed') return { kind: 'hidden' }
  // Either id names the same sale: a refund may have been queued, or acknowledged, under the other one.
  const keys = [i.order.id, i.sale?.orderUuid, i.sale?.serverOrderId, i.serverIdToSaleUuid?.get(i.order.id)].filter((k): k is string => !!k)
  if (i.syncedRefundOrderIds && keys.some((k) => i.syncedRefundOrderIds!.has(k))) return { kind: 'blocked', reason: REFUND_DONE }
  if (!i.canRefund) return { kind: 'blocked', reason: REFUND_NO_PERMISSION }
  if (keys.some((k) => i.queuedOrderIds.has(k) || i.queuedSaleUuids?.has(k))) return { kind: 'blocked', reason: REFUND_QUEUED }
  if (!i.hasOpenShift) return { kind: 'blocked', reason: i.shiftUnsynced ? REFUND_SHIFT_UNSYNCED : REFUND_NO_SHIFT }
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
  // Display snapshot, written ONCE here and never touched again: the server fingerprints the
  // canonical payload per sync key and never reads these keys.
  orderNumber: string
  total: number
  paymentMethod: string
  /** The shift the sale belonged to (null when history did not say). */
  saleShiftId: string | null
}

export type PreparedRefund = { ok: true; payload: RefundPayload } | { ok: false; message: string }

export function prepareRefund(i: {
  order: Pick<Order, 'id' | 'orderNumber' | 'total' | 'paymentMethod' | 'shiftId'>
  reason: string
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
  return {
    ok: true,
    payload: {
      orderId: i.sale ? (i.sale.serverOrderId ?? '') : i.order.id,
      ...(i.sale ? { saleOrderUuid: i.sale.orderUuid } : {}),
      reason,
      orderNumber: i.order.orderNumber,
      total: i.order.total,
      paymentMethod: i.order.paymentMethod,
      saleShiftId: i.order.shiftId ?? null,
    },
  }
}

/** "BSD-G0007 · Rp 225.000 · Tunai" from a refund's captured snapshot; undefined for items queued
 *  before the snapshot existed (they render as before). */
export function refundDetail(payload: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!payload) return undefined
  const { orderNumber, total, paymentMethod } = payload
  if (typeof orderNumber !== 'string' || orderNumber === '' || typeof total !== 'number' || !Number.isFinite(total)) return undefined
  const method = typeof paymentMethod === 'string' && paymentMethod !== '' ? (PAYMENT_LABELS[paymentMethod] ?? paymentMethod) : null
  return [orderNumber, formatRupiah(total), method].filter((p) => p !== null).join(' · ')
}

export type RefundSubmitPlan =
  | { kind: 'enqueue'; payload: RefundPayload }
  | { kind: 'error'; message: string }

/** What handleRefundConfirm does: the dialog's order must be the one confirmed, and every guard passes,
 *  before anything is queued. The payload is the prepared one, verbatim. */
export function planRefundSubmit(i: {
  refundOrder: Order | null
  orderId: string
  reason: string
  canRefund: boolean
  shiftId: string | null | undefined
  sale?: LocalSaleRef
}): RefundSubmitPlan {
  if (!i.refundOrder || i.refundOrder.id !== i.orderId) {
    return { kind: 'error', message: 'Transaksi refund tidak cocok. Tutup lalu coba lagi.' }
  }
  const prepared = prepareRefund({ order: i.refundOrder, reason: i.reason, canRefund: i.canRefund, shiftId: i.shiftId, sale: i.sale })
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
}) {
  return {
    canRefund: userCanRefund(i.user),
    hasOpenShift: !!i.currentShift?.id,
    shiftUnsynced: !!i.currentShift && !i.currentShift.id,
    queuedRefundOrderIds: i.queuedOrderIds,
    syncedRefundOrderIds: i.syncedRefundOrderIds,
    queuedSaleUuids: i.queuedSaleUuids,
    serverIdToSaleUuid: i.serverIdToSaleUuid,
  }
}
