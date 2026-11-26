import { ApiError, type Api, type CrossOutletRefundRequest, type CrossOutletRefundResult } from '@mandalika/api'
import { formatRupiah } from '../pricing'
import type { RefundPayload } from '../refundView'
import type { AttemptStore, PendingAttempt } from './crossOutletAttempt'

export const CROSS_OFFLINE_REFUND = 'Butuh internet. Refund outlet lain hanya bisa online.'
export const CROSS_STORE_FAILED = 'Tablet tidak dapat menyimpan data refund. Coba lagi.'
/** The A29 "check first" copy: the server may or may not have stored the refund. */
export const CROSS_CHECK_FIRST = 'Server tidak menjawab tepat waktu. Cek dulu apakah perubahan sudah tersimpan sebelum mengulang.'
export const CROSS_PENDING_OTHER = 'Masih ada refund outlet lain yang belum terjawab di tablet ini. Kirim ulang atau cek dulu sebelum membuat refund baru.'

export type CrossOutletOutcome =
  | { kind: 'offline'; message: string }
  | { kind: 'storeFailed'; message: string }
  /** A pending attempt exists that this request does not match: nothing was sent, no new uuid was made. */
  | { kind: 'blocked'; message: string }
  | { kind: 'applied'; replayed: boolean; message: string; result: CrossOutletRefundResult }
  /** No usable answer (timeout, network, 5xx, 503): the attempt is kept; pay nothing until it is checked. */
  | { kind: 'unsure'; message: string }
  /** The server refused (400/403/409...): the attempt is cleared; the message is the server's. */
  | { kind: 'refused'; message: string }

export interface CrossOutletDeps {
  api: Pick<Api, 'refundCrossOutlet'>
  store: AttemptStore
  newUuid: () => string
  isOnline: boolean
  now?: () => Date
}

export interface CrossOutletSubmit {
  orderId: string
  orderNumber: string
  shiftId: string
  deviceId: string
  /** The planned refund (planRefundSubmit): the single source of items, amount, reason and payout. */
  payload: Pick<RefundPayload, 'items' | 'refundAmount' | 'reason' | 'reasonCode' | 'payoutMethod' | 'payoutPicked'>
}

/** Deterministic key order, so the same selection always serialises to the same bytes. */
function bodyJsonOf(s: CrossOutletSubmit, uuid: string): string {
  const p = s.payload
  const body: CrossOutletRefundRequest = {
    clientRefundUuid: uuid, deviceId: s.deviceId, shiftId: s.shiftId, reason: p.reason,
    ...(p.reasonCode ? { reasonCode: p.reasonCode } : {}),
    ...(p.items ? { items: p.items.map((i) => ({ lineNo: i.lineNo, quantity: i.quantity })) } : {}),
    ...(typeof p.refundAmount === 'number' ? { refundAmount: p.refundAmount } : {}),
    ...(p.payoutMethod ? { payoutMethod: p.payoutMethod, payoutPicked: p.payoutPicked !== false } : {}),
  }
  return JSON.stringify(body)
}

/** Statuses where the server definitely did not apply the refund: safe to forget the attempt. */
const REFUSED = new Set([400, 403, 404, 405, 409, 413, 422])

async function send(deps: CrossOutletDeps, a: PendingAttempt): Promise<CrossOutletOutcome> {
  try {
    const result = await deps.api.refundCrossOutlet(a.orderId, JSON.parse(a.bodyJson) as CrossOutletRefundRequest)
    deps.store.clear()
    const no = a.orderNumber ? ` ${a.orderNumber}` : ''
    const message = result.replayed
      ? `Refund ini sudah tersimpan sebelumnya (${formatRupiah(result.amount)}). Bayar hanya jika belum dibayar.`
      : `Refund${no} berhasil. Bayar ${formatRupiah(result.amount)} ke pelanggan.`
    return { kind: 'applied', replayed: result.replayed, message, result }
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && REFUSED.has(e.status)) {
      deps.store.clear()
      return { kind: 'refused', message: e.message }
    }
    return { kind: 'unsure', message: CROSS_CHECK_FIRST }
  }
}

/** Sends a new cross-outlet refund. Online only; nothing is stored or sent while offline. */
export async function submitCrossOutletRefund(deps: CrossOutletDeps, s: CrossOutletSubmit): Promise<CrossOutletOutcome> {
  if (!deps.isOnline) return { kind: 'offline', message: CROSS_OFFLINE_REFUND }
  const pending = deps.store.read()
  if (pending) {
    // Never mint a new uuid while an attempt is unanswered: the same selection resends the stored body, anything else waits.
    if (pending.orderId !== s.orderId) return { kind: 'blocked', message: CROSS_PENDING_OTHER }
    if (bodyJsonOf(s, pending.uuid) !== pending.bodyJson) return { kind: 'blocked', message: CROSS_CHECK_FIRST }
    return send(deps, pending)
  }
  const uuid = deps.newUuid()
  const attempt: PendingAttempt = {
    uuid, orderId: s.orderId, orderNumber: s.orderNumber, bodyJson: bodyJsonOf(s, uuid), createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  }
  if (!deps.store.write(attempt)) return { kind: 'storeFailed', message: CROSS_STORE_FAILED }
  return send(deps, attempt)
}

/** "Kirim ulang refund sebelumnya": resends exactly what was stored. Null when nothing is pending. */
export async function resendPendingCrossOutletRefund(deps: CrossOutletDeps): Promise<CrossOutletOutcome | null> {
  const pending = deps.store.read()
  if (!pending) return null
  if (!deps.isOnline) return { kind: 'offline', message: CROSS_OFFLINE_REFUND }
  return send(deps, pending)
}

/** A canonical v4 uuid (the server refuses anything else as the replay key). */
export function newRefundUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16)
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
