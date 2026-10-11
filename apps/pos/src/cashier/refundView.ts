import type { components } from '@mandalika/api'
import { MAX_REFUND_REASON_CHARS } from '@mandalika/types'
import { formatRupiah } from './pricing'

type Order = components['schemas']['Order']

// Pure rules behind the refund UI (A06): what the history panel offers, what CashierScreen
// queues, and how a parked refund reads in the review list. The gate is UI-only; the server decides.

export const REFUND_NO_PERMISSION = 'Butuh izin Proses Refund'
export const REFUND_QUEUED = 'Refund menunggu sinkronisasi'
export const REFUND_NO_SHIFT = 'Buka shift dulu'

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS',
}

export type RefundAvailability =
  | { kind: 'allowed' }
  | { kind: 'hidden' }
  | { kind: 'blocked'; reason: string }

export interface RefundAvailabilityInput {
  order: Pick<Order, 'id' | 'status'>
  canRefund: boolean
  /** A synced open shift exists: a refund pays out of that drawer (B3). */
  hasOpenShift: boolean
  /** Orders with a queued or parked (unacknowledged) refund on this device. */
  queuedOrderIds: ReadonlySet<string>
}

export function refundAvailability(i: RefundAvailabilityInput): RefundAvailability {
  if (i.order.status !== 'completed') return { kind: 'hidden' }
  if (!i.canRefund) return { kind: 'blocked', reason: REFUND_NO_PERMISSION }
  if (i.queuedOrderIds.has(i.order.id)) return { kind: 'blocked', reason: REFUND_QUEUED }
  if (!i.hasOpenShift) return { kind: 'blocked', reason: REFUND_NO_SHIFT }
  return { kind: 'allowed' }
}

/** Same count the server applies: runes of the trimmed reason. */
export const canSubmitRefundReason = (reason: string): boolean => {
  const t = reason.trim()
  return t !== '' && [...t].length <= MAX_REFUND_REASON_CHARS
}

export interface RefundPayload {
  orderId: string
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
  /** Server id of the open shift; '' / null = none (a not-yet-synced open cannot be attributed). */
  shiftId: string | null | undefined
}): PreparedRefund {
  if (!i.canRefund) return { ok: false, message: REFUND_NO_PERMISSION }
  if (!i.shiftId) return { ok: false, message: REFUND_NO_SHIFT }
  const reason = i.reason.trim()
  if (!canSubmitRefundReason(reason)) {
    return { ok: false, message: reason === '' ? 'Alasan refund wajib diisi' : `Alasan refund maksimal ${MAX_REFUND_REASON_CHARS} karakter` }
  }
  return {
    ok: true,
    payload: {
      orderId: i.order.id,
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
