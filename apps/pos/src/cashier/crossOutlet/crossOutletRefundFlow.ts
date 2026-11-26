import { ApiError, type Api, type CrossOutletRefundRequest, type CrossOutletRefundResult } from '@mandalika/api'
import { formatRupiah } from '../pricing'
import type { RefundPayload } from '../refundView'
import type { AttemptStore, PendingAttempt } from './crossOutletAttempt'

export const CROSS_OFFLINE_REFUND = 'Butuh internet. Refund outlet lain hanya bisa online.'
export const CROSS_STORE_FAILED = 'Tablet tidak dapat menyimpan data refund. Coba lagi.'
/** The A29 "check first" copy: the server may or may not have stored the refund. */
export const CROSS_CHECK_FIRST = 'Server tidak menjawab tepat waktu. Cek dulu apakah perubahan sudah tersimpan sebelum mengulang.'
/** A refund for ANOTHER sale is still unanswered on this tablet: open that sale (Cek transaksi) before making a new one. */
export const crossPendingOther = (orderNumber: string): string =>
  `Refund ${orderNumber ? `#${orderNumber} ` : ''}belum terjawab. Buka transaksi itu dulu (Cek transaksi).`

export type CrossOutletOutcome =
  | { kind: 'offline'; message: string }
  | { kind: 'storeFailed'; message: string }
  /** A pending attempt exists that this request does not match: nothing was sent, no new uuid was made. */
  | { kind: 'blocked'; message: string }
  | { kind: 'applied'; replayed: boolean; message: string; result: CrossOutletRefundResult; sent: SentRefund }
  /** No usable answer (timeout, network, 5xx, 503): the attempt is kept; pay nothing until it is checked. */
  | { kind: 'unsure'; message: string }
  /** The server refused (400/403/409...): the attempt is cleared; the message is the server's. */
  | { kind: 'refused'; message: string }

/** The sale and reason that were actually sent (from the stored attempt), whatever the dialog shows now. */
export interface SentRefund { orderId: string; orderNumber: string; reason: string }

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

/** Refused whatever came before: the answer depends only on the body. */
const REFUSED_ALWAYS = new Set([400, 409, 413, 422])
/** Permission revoked / route missing (rollback) can ALSO follow an earlier send whose answer was lost and which was
 *  applied: only the first send may treat these as "not applied". */
const REFUSED_FIRST_SEND = new Set([403, 404, 405])

/** A 2xx body that is usable: the refund row, the amount and the replay flag are all there. */
function isUsableResult(r: unknown): r is CrossOutletRefundResult {
  const x = r as Partial<CrossOutletRefundResult> | null | undefined
  return !!x && typeof x.replayed === 'boolean' && typeof x.amount === 'number' && !!x.refund && !!x.order?.order
}

const sentOf = (a: PendingAttempt): SentRefund => {
  let reason = ''
  try { reason = String((JSON.parse(a.bodyJson) as { reason?: unknown }).reason ?? '') } catch { /* keep empty */ }
  return { orderId: a.orderId, orderNumber: a.orderNumber, reason }
}

async function send(deps: CrossOutletDeps, a: PendingAttempt): Promise<CrossOutletOutcome> {
  const firstSend = a.sends <= 1
  try {
    const result = await deps.api.refundCrossOutlet(a.orderId, JSON.parse(a.bodyJson) as CrossOutletRefundRequest)
    // An empty or malformed 2xx proves nothing: keep the attempt and make the cashier check.
    if (!isUsableResult(result)) return { kind: 'unsure', message: CROSS_CHECK_FIRST }
    await deps.store.clear()
    const no = a.orderNumber ? ` ${a.orderNumber}` : ''
    const message = result.replayed
      ? `Refund ini sudah tersimpan sebelumnya (${formatRupiah(result.amount)}). Bayar hanya jika belum dibayar.`
      : `Refund${no} berhasil. Bayar ${formatRupiah(result.amount)} ke pelanggan.`
    return { kind: 'applied', replayed: result.replayed, message, result, sent: sentOf(a) }
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && (REFUSED_ALWAYS.has(e.status) || (firstSend && REFUSED_FIRST_SEND.has(e.status)))) {
      await deps.store.clear()
      return { kind: 'refused', message: e.message }
    }
    return { kind: 'unsure', message: CROSS_CHECK_FIRST }
  }
}

/** Counts the send BEFORE it leaves, so a later 403/404/405 knows an earlier send may have been applied. */
async function sendAgain(deps: CrossOutletDeps, pending: PendingAttempt): Promise<CrossOutletOutcome> {
  const next = { ...pending, sends: pending.sends + 1 }
  await deps.store.write(next) // best effort: `next` is what send() reads either way
  return send(deps, next)
}

/** Sends a new cross-outlet refund. Online only; nothing is stored or sent while offline. */
export async function submitCrossOutletRefund(deps: CrossOutletDeps, s: CrossOutletSubmit): Promise<CrossOutletOutcome> {
  if (!deps.isOnline) return { kind: 'offline', message: CROSS_OFFLINE_REFUND }
  const pending = deps.store.read()
  if (pending) {
    // Never mint a new uuid while an attempt is unanswered: the same selection resends the stored body, anything else waits.
    if (pending.orderId !== s.orderId) return { kind: 'blocked', message: crossPendingOther(pending.orderNumber) }
    if (bodyJsonOf(s, pending.uuid) !== pending.bodyJson) return { kind: 'blocked', message: CROSS_CHECK_FIRST }
    return sendAgain(deps, pending)
  }
  const uuid = deps.newUuid()
  const attempt: PendingAttempt = {
    uuid, orderId: s.orderId, orderNumber: s.orderNumber, bodyJson: bodyJsonOf(s, uuid), createdAt: (deps.now ?? (() => new Date()))().toISOString(), sends: 1,
  }
  if (!(await deps.store.write(attempt))) return { kind: 'storeFailed', message: CROSS_STORE_FAILED }
  return send(deps, attempt)
}

/** "Kirim ulang refund sebelumnya": resends exactly what was stored. Null when nothing is pending. */
export async function resendPendingCrossOutletRefund(deps: CrossOutletDeps): Promise<CrossOutletOutcome | null> {
  const pending = deps.store.read()
  if (!pending) return null
  if (!deps.isOnline) return { kind: 'offline', message: CROSS_OFFLINE_REFUND }
  return sendAgain(deps, pending)
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
