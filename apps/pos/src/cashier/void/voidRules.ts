import type { components } from '@mandalika/api'
import { canVoidAny, canVoidOwnShift, type AppUser, type Shift } from '@mandalika/types'
import type { TenderLine } from '../tenderSplit'

type Order = components['schemas']['Order']

// Pure rules behind the POS void UI (Void phase 3): what the history offers, how a reason is validated, and the
// `void` outbox payload. The gate is UI-only; the server decides (permissions come from the token, never the payload).

export type VoidReasonCode =
  | 'salah_metode_pembayaran' | 'salah_barang' | 'salah_promo' | 'salah_pelanggan' | 'transaksi_ganda' | 'transaksi_tes' | 'lainnya'

export const VOID_REASONS: readonly { code: VoidReasonCode; label: string }[] = [
  { code: 'salah_metode_pembayaran', label: 'Salah metode pembayaran' },
  { code: 'salah_barang', label: 'Salah barang' },
  { code: 'salah_promo', label: 'Salah promo' },
  { code: 'salah_pelanggan', label: 'Salah pelanggan' },
  { code: 'transaksi_ganda', label: 'Transaksi ganda' },
  { code: 'transaksi_tes', label: 'Transaksi tes' },
  { code: 'lainnya', label: 'Lainnya' },
]

export const VOID_NOTE_MAX = 500
export const VOID_NOTE_MIN_LAINNYA = 10
export const VOID_NOTE_REQUIRED = 'Catatan wajib diisi minimal 10 karakter untuk alasan Lainnya.'
export const VOID_BLOCKED_NO_PERMISSION = 'Butuh izin batalkan transaksi'
export const VOID_BLOCKED_BACKOFFICE = 'Batalkan lewat Backoffice'
export const VOID_BLOCKED_QUEUED = 'Pembatalan menunggu terkirim'
export const VOID_BLOCKED_REFUNDED = 'Sudah direfund'
export const VOID_BLOCKED_SHIFT_UNSYNCED = 'Shift masih tersimpan di tablet'

const runes = (s: string): number => [...s].length

/** Same count the server applies: runes of the trimmed note. */
export function voidReasonProblem(code: VoidReasonCode | null, note: string): string | null {
  if (!code) return 'Pilih alasan'
  const n = note.trim()
  if (runes(n) > VOID_NOTE_MAX) return `Catatan maksimal ${VOID_NOTE_MAX} karakter`
  if (code === 'lainnya' && runes(n) < VOID_NOTE_MIN_LAINNYA) return VOID_NOTE_REQUIRED
  return null
}

/** A sale made on this tablet, named by its client uuid (A41), with the receipt facts the void rules need. The caller
 *  maps a LocalReceipt onto it (`total` = quotedTotal ?? snapshot total; `lines` = units from the receipt snapshot). A
 *  synced local sale may instead be passed as its server `Order`. Mirrors refundView's LocalSaleRef plus those facts. */
export interface LocalVoidSale {
  orderUuid: string
  serverOrderId?: string
  orderNumber: string
  total: number
  shiftId: string | null
  /** When the tablet recorded the sale (ISO). */
  capturedAt: string
  /** The sale's payment lines (applied amounts); absent on a single-method sale from before C6. */
  tenders?: TenderLine[]
  paymentMethod?: string
  /** Units sold, for the stock overlay (restockLines). */
  lines?: { productId: string; variantSize: string; quantity: number }[]
  refundQueued?: boolean
  refunded?: boolean
  voidQueued?: boolean
  voided?: boolean
}

export type VoidAvailability =
  | { kind: 'hidden' }
  | { kind: 'blocked'; label: string }
  | { kind: 'void' }
  | { kind: 'create_replacement' }

export interface VoidAvailabilityInput {
  order: Order | LocalVoidSale
  user: Pick<AppUser, 'role' | 'permissions'> | null
  deviceId: string
  currentShift: Shift | null
  queuedVoidIds: ReadonlySet<string>
  queuedRefundIds: ReadonlySet<string>
}

const isLocal = (o: Order | LocalVoidSale): o is LocalVoidSale => 'orderUuid' in o

const blocked = (label: string): VoidAvailability => ({ kind: 'blocked', label })

/** Whether `iso` is at or after `openedAt` (both ISO). An unparsable value never matches. */
const notBefore = (iso: string, openedAt: string): boolean => {
  const a = Date.parse(iso)
  const b = Date.parse(openedAt)
  return Number.isFinite(a) && Number.isFinite(b) && a >= b
}

export function voidAvailability(i: VoidAvailabilityInput): VoidAvailability {
  const o = i.order
  const local = isLocal(o)
  const keys = (local ? [o.orderUuid, o.serverOrderId] : [o.id]).filter((k): k is string => !!k)
  const status = local ? (o.voided ? 'cancelled' : 'completed') : o.status

  if (status === 'cancelled') {
    // A voided sale: only a later-mode void without a followup offers "Buat pengganti", and only with void_any.
    const v = local ? undefined : o.void
    return v?.mode === 'later' && !v.followup && canVoidAny(i.user) ? { kind: 'create_replacement' } : { kind: 'hidden' }
  }

  const refunded = local
    ? !!(o.refunded || o.refundQueued)
    : status !== 'completed' || (o.refunds?.length ?? 0) > 0 || (o.refundedAmount ?? 0) > 0
  if (refunded || keys.some((k) => i.queuedRefundIds.has(k))) return blocked(VOID_BLOCKED_REFUNDED)

  // queuedVoidIds never holds a parked void (engine.queuedVoidOrderIds skips it), so a parked void lets the cashier try again.
  if ((local && o.voidQueued) || keys.some((k) => i.queuedVoidIds.has(k))) return blocked(VOID_BLOCKED_QUEUED)

  const shift = i.currentShift
  if (shift && shift.id === '') return blocked(VOID_BLOCKED_SHIFT_UNSYNCED)

  const saleShiftId = o.shiftId ? o.shiftId : null
  const shiftId = shift?.id ? shift.id : null
  let own = shiftId !== null && saleShiftId === shiftId
  if (!own && shift && shiftId !== null && saleShiftId === null) {
    // O5: an unattributed sale rung on this tablet since the shift opened. The server decides with orders.device_id.
    const here = local ? true : !!o.deviceId && o.deviceId === i.deviceId
    own = here && notBefore(local ? o.capturedAt : o.createdAt, shift.openedAt)
  }
  if (!own) return blocked(VOID_BLOCKED_BACKOFFICE)
  return canVoidOwnShift(i.user) ? { kind: 'void' } : blocked(VOID_BLOCKED_NO_PERMISSION)
}

/** The review reason of a parked void on this sale (display only), or null. `keys` are the sale's ids (server id, uuid). */
export function parkedVoidNote(
  voids: readonly { orderId: string; saleOrderUuid?: string; parked: boolean; reviewReason?: string }[],
  keys: readonly string[],
): string | null {
  const hit = voids.find((v) => v.parked && (keys.includes(v.orderId) || (!!v.saleOrderUuid && keys.includes(v.saleOrderUuid))))
  return hit?.reviewReason ?? null
}

export interface VoidPayloadInput {
  order: Order | LocalVoidSale
  reason: VoidReasonCode
  note: string
  mode: 'none' | 'replace'
  stockChoices?: Record<string, 'restock' | 'skip_counted'>
  /** The exact order payload of the replacement sale plus `correctionTarget` (Task 3.3 stamps deviceId). Used only for mode replace. */
  replacement?: Record<string, unknown>
  /** The outlet's giveaway item when the sale took one unit of it (C3: the server takes one per completed order). */
  giveaway?: { productId: string; variantSize: string } | null
}

type RestockLine = { productId: string; variantSize: string; quantity: number }

/** Units a void gives back, merged per product+size. Order items include bundle pieces and reward lines (all decrement stock). */
function restockLinesOf(i: VoidPayloadInput): RestockLine[] {
  const o = i.order
  const src: RestockLine[] = isLocal(o)
    ? (o.lines ?? [])
    : o.items.map((l) => ({ productId: l.productId, variantSize: l.variantSize, quantity: l.quantity }))
  const out = new Map<string, RestockLine>()
  const add = (l: RestockLine): void => {
    if (!l.productId || !(l.quantity > 0)) return
    const key = `${l.productId}|${l.variantSize}`
    const cur = out.get(key)
    out.set(key, cur ? { ...cur, quantity: cur.quantity + l.quantity } : { productId: l.productId, variantSize: l.variantSize, quantity: l.quantity })
  }
  src.forEach(add)
  if (i.giveaway) add({ productId: i.giveaway.productId, variantSize: i.giveaway.variantSize, quantity: 1 })
  return [...out.values()]
}

/** The tenders as APPLIED (an order tender's `amount`, never `tendered`), else one line for the sale method. */
function originalTendersOf(o: Order | LocalVoidSale): TenderLine[] {
  if (isLocal(o)) {
    if (o.tenders && o.tenders.length > 0) return o.tenders.map((t) => ({ method: t.method, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) }))
    return o.paymentMethod ? [{ method: o.paymentMethod, amount: o.total }] : []
  }
  if (o.tenders && o.tenders.length > 0) {
    return [...o.tenders].sort((a, b) => a.seq - b.seq).map((t) => ({ method: t.method, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) }))
  }
  return [{ method: o.paymentMethod, amount: o.total }]
}

/** The `void` sync payload (SyncVoidPayload): written once and never mutated (A11). The display facts (restockLines,
 *  originalTenders, originalShiftId, orderNumber, total) feed the tablet's own overlays; the server ignores them. */
export function buildVoidPayload(i: VoidPayloadInput): Record<string, unknown> {
  const o = i.order
  const note = i.note.trim()
  const shiftId = o.shiftId ? o.shiftId : null
  const choices = i.stockChoices && Object.keys(i.stockChoices).length > 0 ? { ...i.stockChoices } : null
  return {
    orderId: isLocal(o) ? (o.serverOrderId ?? '') : o.id,
    ...(isLocal(o) ? { saleOrderUuid: o.orderUuid } : {}),
    reasonCode: i.reason,
    ...(note ? { note } : {}),
    mode: i.mode,
    ...(choices ? { stockChoices: choices } : {}),
    orderNumber: o.orderNumber,
    total: o.total,
    restockLines: restockLinesOf(i),
    originalTenders: originalTendersOf(o),
    ...(shiftId ? { originalShiftId: shiftId } : {}),
    ...(i.mode === 'replace' && i.replacement ? { replacement: { ...i.replacement } } : {}),
  }
}
