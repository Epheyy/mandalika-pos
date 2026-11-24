import type { components } from '@mandalika/api'
import { canVoidAny, canVoidOwnShift, isCashMethod, type CashFlagMethod, type Shift } from '@mandalika/types'
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
export const VOID_BLOCKED_NOT_OWN_SALE = 'Transaksi ini dicatat kasir lain. Pembatalannya perlu izin membatalkan semua transaksi.'
export const VOID_BLOCKED_BACKOFFICE = 'Batalkan lewat Backoffice'
export const VOID_BLOCKED_QUEUED = 'Pembatalan menunggu terkirim'
export const VOID_BLOCKED_REFUNDED = 'Sudah direfund'
export const VOID_BLOCKED_DRAFT = 'Selesaikan atau batalkan pengganti dulu'
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
  user: { id?: string; role: string; permissions?: readonly string[] | null } | null
  deviceId: string
  currentShift: Pick<Shift, 'id' | 'status' | 'openedAt'> | null
  queuedVoidIds: ReadonlySet<string>
  queuedRefundIds: ReadonlySet<string>
  /** Sales whose void this tablet saw acknowledged (engine.syncedVoidOrderIds()): a stale cached row may still say completed. */
  syncedVoidIds: ReadonlySet<string>
  /** Voided order ids that already have a queued "Buat pengganti" sale (engine.queuedReplacementOrderIds()). */
  queuedReplacementOf: ReadonlySet<string>
  /** A replacement cart (void draft) is open: no other void or "Buat pengganti" may start until it is finished or dropped. */
  draftOpen?: boolean
}

const isLocal = (o: Order | LocalVoidSale): o is LocalVoidSale => 'orderUuid' in o

const blocked = (label: string): VoidAvailability => ({ kind: 'blocked', label })

/** Whether `iso` is at or after `openedAt` (both ISO). An unparsable value never matches. */
const notBefore = (iso: string, openedAt: string): boolean => {
  const a = Date.parse(iso)
  const b = Date.parse(openedAt)
  return Number.isFinite(a) && Number.isFinite(b) && a >= b
}

/** What the history offers for a sale. The draft lock never hides a sale, it only blocks what would be offered. */
export function voidAvailability(i: VoidAvailabilityInput): VoidAvailability {
  const a = voidAvailabilityBase(i)
  return i.draftOpen && (a.kind === 'void' || a.kind === 'create_replacement') ? blocked(VOID_BLOCKED_DRAFT) : a
}

function voidAvailabilityBase(i: VoidAvailabilityInput): VoidAvailability {
  const o = i.order
  const local = isLocal(o)
  const keys = (local ? [o.orderUuid, o.serverOrderId] : [o.id]).filter((k): k is string => !!k)
  const status = local ? (o.voided ? 'cancelled' : 'completed') : o.status

  if (status === 'cancelled') {
    // A voided sale: only a later-mode void without a followup offers "Buat pengganti", and only with void_any, and
    // not again while its replacement is queued. The void window (app_settings.void_window_days) lives on the server
    // and is not known to the tablet, so it is not checked here: the server refuses an out-of-window replacement.
    const v = local ? undefined : o.void
    const offered = v?.mode === 'later' && !v.followup && canVoidAny(i.user) && !keys.some((k) => i.queuedReplacementOf.has(k))
    return offered ? { kind: 'create_replacement' } : { kind: 'hidden' }
  }
  // Any state other than a plain completed or a refunded sale offers nothing.
  const refundedStatus = status === 'refunded' || status === 'partially_refunded'
  if (status !== 'completed' && !refundedStatus) return { kind: 'hidden' }
  // A stale cached row may still say completed after this tablet saw the void acknowledged.
  if (keys.some((k) => i.syncedVoidIds.has(k))) return { kind: 'hidden' }

  const refunded = local
    ? !!(o.refunded || o.refundQueued)
    : refundedStatus || (o.refunds?.length ?? 0) > 0 || (o.refundedAmount ?? 0) > 0
  if (refunded || keys.some((k) => i.queuedRefundIds.has(k))) return blocked(VOID_BLOCKED_REFUNDED)

  // queuedVoidIds never holds a parked void (engine.queuedVoidOrderIds skips it), so a parked void lets the cashier try again.
  if ((local && o.voidQueued) || keys.some((k) => i.queuedVoidIds.has(k))) return blocked(VOID_BLOCKED_QUEUED)

  const shift = i.currentShift
  if (shift && shift.id === '') return blocked(VOID_BLOCKED_SHIFT_UNSYNCED)

  const saleShiftId = o.shiftId ? o.shiftId : null
  const shiftId = shift?.id && shift.status === 'open' ? shift.id : null
  let own = shiftId !== null && saleShiftId === shiftId
  if (!own && shift && shiftId !== null && saleShiftId === null) {
    // O5: an unattributed sale rung on this tablet since the shift opened. The server decides with orders.device_id.
    const here = local ? true : !!o.deviceId && o.deviceId === i.deviceId
    own = here && notBefore(local ? o.capturedAt : o.createdAt, shift.openedAt)
  }
  if (!own) return blocked(VOID_BLOCKED_BACKOFFICE)
  // Void policy 2026-11-24: void_own_shift covers only the caller's own sales. A colleague's sale in the shared shift needs
  // void_any. A sale rung on this tablet (local) counts as own; with either id unknown the server decides (it re-judges anyway).
  const colleagues = !local && !!o.cashierId && !!i.user?.id && o.cashierId !== i.user.id
  if (colleagues) return canVoidAny(i.user) ? { kind: 'void' } : blocked(VOID_BLOCKED_NOT_OWN_SALE)
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
  /** Payment-method settings, to tell a cash line when trimming a captured amount to the applied one. */
  methods?: readonly CashFlagMethod[]
  /** The outlet's giveaway item when the sale took one unit of it (C3: the server takes one per completed order). */
  giveaway?: { productId: string; variantSize: string } | null
  /** The preview's lines: maps a stockChoices key to its product, size and quantity so a skip_counted line is not restocked. */
  previewLines?: readonly { key: string; productId: string; variantSize: string; quantity: number }[]
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
  // A line the cashier left to the stock count ("sudah dikoreksi oleh stock opname") gives nothing back: the server
  // skips it, so the tablet's displayed stock must not rise for it either.
  for (const l of i.previewLines ?? []) {
    if (i.stockChoices?.[l.key] !== 'skip_counted') continue
    const k = `${l.productId}|${l.variantSize}`
    const cur = out.get(k)
    if (!cur) continue
    const left = cur.quantity - l.quantity
    if (left > 0) out.set(k, { ...cur, quantity: left })
    else out.delete(k)
  }
  return [...out.values()]
}

/** Lines as APPLIED to a bill of `total`: a cash line that carries change (captured > due) is trimmed by the excess,
 *  last cash line first. Non-cash lines are never touched. Lines left at 0 are dropped (one line is always kept). */
export function appliedTenders(tenders: readonly TenderLine[], total: number, methods?: readonly CashFlagMethod[]): TenderLine[] {
  const out = tenders.map((t) => ({ ...t }))
  let excess = out.reduce((n, t) => n + t.amount, 0) - total
  for (let k = out.length - 1; k >= 0 && excess > 0; k--) {
    if (!isCashMethod(methods, out[k].method)) continue
    const cut = Math.min(excess, out[k].amount)
    out[k] = { ...out[k], amount: out[k].amount - cut }
    excess -= cut
  }
  const kept = out.filter((t) => t.amount > 0)
  return kept.length > 0 ? kept : out
}

/** The original tenders as APPLIED. A server order's `amount` already is; a local receipt's tenders are CAPTURED
 *  (cash handed over), so cash change is trimmed off against the sale total. */
export function originalTendersOf(o: Order | LocalVoidSale, methods?: readonly CashFlagMethod[]): TenderLine[] {
  if (isLocal(o)) {
    if (o.tenders && o.tenders.length > 0) {
      return appliedTenders(o.tenders.map((t) => ({ method: t.method, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) })), o.total, methods)
    }
    return o.paymentMethod ? [{ method: o.paymentMethod, amount: o.total }] : []
  }
  if (o.tenders && o.tenders.length > 0) {
    return [...o.tenders].sort((a, b) => a.seq - b.seq).map((t) => ({ method: t.method, amount: t.amount, ...(t.reference ? { reference: t.reference } : {}) }))
  }
  return [{ method: o.paymentMethod, amount: o.total }]
}

/** What the replacement costs the customer: the original total when the gap is booked as a correction, else the cart's
 *  quoted total. Undefined when the replacement does not say. */
function replacementDueOf(replacement: Record<string, unknown>, originalTotal: number): number | undefined {
  if (replacement.correctionTarget === 'original_total') return originalTotal
  if (typeof replacement.quotedTotal === 'number' && Number.isFinite(replacement.quotedTotal)) return replacement.quotedTotal
  const snap = replacement.receiptSnapshot as { total?: unknown } | null | undefined
  return snap && typeof snap.total === 'number' && Number.isFinite(snap.total) ? snap.total : undefined
}

/** The replacement's payment lines as APPLIED (cash change trimmed with the outlet's own cash methods), or undefined. */
function replacementTendersOf(r: Record<string, unknown> | undefined, originalTotal: number, methods?: readonly CashFlagMethod[]): TenderLine[] | undefined {
  if (!r || !Array.isArray(r.tenders)) return undefined
  const lines = (r.tenders as { method?: unknown; amount?: unknown; reference?: unknown }[])
    .filter((t) => typeof t.method === 'string' && typeof t.amount === 'number')
    .map((t) => ({ method: t.method as string, amount: t.amount as number, ...(typeof t.reference === 'string' && t.reference ? { reference: t.reference } : {}) }))
  if (lines.length === 0) return undefined
  const due = replacementDueOf(r, originalTotal)
  return due === undefined ? lines : appliedTenders(lines, due, methods)
}

/** The `void` sync payload (SyncVoidPayload): written once and never mutated (A11). The display facts (restockLines,
 *  originalTenders, replacementTenders, originalShiftId, orderNumber, total) feed the tablet's own overlays; the server ignores
 *  them. `tendersApplied` says the tender lines are already the APPLIED amounts (trimmed with this outlet's cash methods), so
 *  the engine does not re-guess cash from the default ids. */
export function buildVoidPayload(i: VoidPayloadInput): Record<string, unknown> {
  if (i.mode === 'replace' && !i.replacement) throw new Error('buildVoidPayload: mode replace needs a replacement')
  const o = i.order
  const note = i.note.trim()
  const shiftId = o.shiftId ? o.shiftId : null
  const choices = i.stockChoices && Object.keys(i.stockChoices).length > 0 ? { ...i.stockChoices } : null
  const appliedReplacement = i.mode === 'replace' ? replacementTendersOf(i.replacement, o.total, i.methods) : undefined
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
    originalTenders: originalTendersOf(o, i.methods),
    tendersApplied: true,
    ...(appliedReplacement ? { replacementTenders: appliedReplacement } : {}),
    ...(shiftId ? { originalShiftId: shiftId } : {}),
    ...(i.mode === 'replace' && i.replacement ? { replacement: { ...i.replacement } } : {}),
  }
}

/** The review row of a queued void: "Batalkan #BSD-G0007". Undefined without a captured order number. */
export function voidDetail(payload: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const no = payload?.orderNumber
  return typeof no === 'string' && no !== '' ? `Batalkan #${no}` : undefined
}
