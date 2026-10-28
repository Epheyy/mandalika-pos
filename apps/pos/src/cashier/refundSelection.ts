import type { components } from '@mandalika/api'
import { MAX_REFUND_REASON_CHARS, variantLabel } from '@mandalika/types'
import { refundAmountForUnits } from './allocateNet'

type Order = components['schemas']['Order']
type OrderItem = Order['items'][number] & { isGiveaway?: boolean }

// C4b: pure rules of the item-level refund dialog (W4). No React, no storage. A refund names lines by their
// position in the sale (`lineNo`), is capped at sold - already refunded, keeps promo groups all-or-nothing (D-34),
// never offers the C3 giveaway bag (D-41), and prices a returned unit at its stored net share (the server's
// `netAmount`, or the TS allocator's share for a sale that has not synced). The last refund settles the remainder
// so every refund of an order adds up to its total. The server stays the authority (it caps and flags).

export const WHOLE_ONLY_NOTE = 'Transaksi lama: refund seluruhnya'
export const GIVEAWAY_NOTE = 'Tas hadiah tidak ikut direfund'
export const GROUP_PARTIAL_NOTE = 'Paket sudah sebagian direfund, tidak bisa dipilih sebagian'
export const LINE_DONE_NOTE = 'Sudah direfund semua'

export interface RefundLine {
  lineNo: number
  name: string
  soldQty: number
  refundedQty: number
  remainingQty: number
  /** What the whole line was paid after discounts (whole rupiah). */
  net: number
  /** Gross unit price, shown struck through when the line was discounted. */
  unitPrice: number
  group: string | null
  /** A Rp0 line given away by a loyalty reward or a promo. */
  isReward: boolean
}

export type RefundBasis =
  | {
      kind: 'lines'
      lines: RefundLine[]
      /** Name of the giveaway bag when the sale carries one: listed, never selectable. */
      giveaway: string | null
      total: number
      /** Paid out so far across earlier refunds of this order. */
      priorAmount: number
    }
  | {
      kind: 'whole'
      items: { name: string; quantity: number; subtotal: number }[]
      giveaway: string | null
      total: number
    }

const itemName = (i: Pick<OrderItem, 'productName' | 'variantSize'>): string => {
  const v = variantLabel(i.variantSize)
  return v ? `${i.productName} ${v}` : i.productName
}

/** What this tablet knows beyond the order row: units/amount refunds it saw acknowledged (a cache; the order's
 *  own `refundedQty` / `refundedAmount` win when larger, so a stale cache can never reduce them). */
export interface RefundCache {
  qtyByLine?: ReadonlyMap<number, number>
  amount?: number
}

/** This tablet saw an earlier per-line refund of the order. */
export const cacheHasRefunds = (c: RefundCache | undefined): boolean =>
  !!c && ((c.amount ?? 0) > 0 || [...(c.qtyByLine?.values() ?? [])].some((q) => q > 0))

/** Build the dialog's basis from an order. Whole-order only when ANY line has no stored net/position (a sale
 *  from before per-line refunds, or a local receipt without line data): D-33. */
export function buildRefundBasis(order: Order, cache: RefundCache = {}): RefundBasis {
  const all = (order.items ?? []) as OrderItem[]
  const giveawayItem = all.find((i) => i.isGiveaway)
  const sale = all.filter((i) => !i.isGiveaway)
  const giveaway = giveawayItem ? itemName(giveawayItem) : null
  const usable = sale.length > 0 && sale.every((i) => typeof i.lineNo === 'number' && Number.isInteger(i.lineNo) && i.lineNo >= 0
    && typeof i.netAmount === 'number' && Number.isSafeInteger(i.netAmount) && i.netAmount >= 0)
  if (!usable) {
    return { kind: 'whole', items: sale.map((i) => ({ name: itemName(i), quantity: i.quantity, subtotal: i.subtotal })), giveaway, total: order.total }
  }
  const lines: RefundLine[] = sale.map((i) => {
    const lineNo = i.lineNo as number
    const refundedQty = Math.min(i.quantity, Math.max(i.refundedQty ?? 0, cache.qtyByLine?.get(lineNo) ?? 0))
    return {
      lineNo,
      name: itemName(i),
      soldQty: i.quantity,
      refundedQty,
      remainingQty: Math.max(0, i.quantity - refundedQty),
      net: i.netAmount as number,
      unitPrice: i.price,
      group: i.refundGroup ?? null,
      isReward: !!i.isReward || i.subtotal === 0,
    }
  })
  return { kind: 'lines', lines, giveaway, total: order.total, priorAmount: Math.max(order.refundedAmount ?? 0, cache.amount ?? 0) }
}

/** lineNo -> units picked. Absent / 0 = not picked. */
export type Selection = Readonly<Record<number, number>>
export const EMPTY_SELECTION: Selection = {}

const groupMembers = (lines: readonly RefundLine[], group: string): RefundLine[] => lines.filter((l) => l.group === group)

/** Why a line cannot be picked (null = selectable). */
export function lineLockReason(line: RefundLine, lines: readonly RefundLine[]): string | null {
  if (line.remainingQty === 0) return LINE_DONE_NOTE
  if (line.group && groupMembers(lines, line.group).some((m) => m.refundedQty > 0)) return GROUP_PARTIAL_NOTE
  return null
}

/** Units that can be picked for the line: its remaining (a grouped line only ever goes whole). */
export const maxQty = (line: RefundLine): number => line.remainingQty

/** Set one line's picked units, clamped to 0..remaining. A grouped line selects or clears its whole group at
 *  each member's full remaining (all-or-nothing, no stepper). A locked line leaves the selection unchanged. */
export function setLineQty(lines: readonly RefundLine[], sel: Selection, lineNo: number, qty: number): Selection {
  const line = lines.find((l) => l.lineNo === lineNo)
  if (!line || lineLockReason(line, lines) !== null) return sel
  const next: Record<number, number> = { ...sel }
  if (line.group) {
    const on = Number.isFinite(qty) && qty > 0
    for (const m of groupMembers(lines, line.group)) {
      if (on) next[m.lineNo] = m.remainingQty
      else delete next[m.lineNo]
    }
    return next
  }
  const clamped = Number.isFinite(qty) ? Math.min(line.remainingQty, Math.max(0, Math.floor(qty))) : 0
  if (clamped === 0) delete next[lineNo]
  else next[lineNo] = clamped
  return next
}

/** Tap on the checkbox: select the line (all remaining units) or clear it. */
export function toggleLine(lines: readonly RefundLine[], sel: Selection, lineNo: number): Selection {
  const line = lines.find((l) => l.lineNo === lineNo)
  if (!line) return sel
  return setLineQty(lines, sel, lineNo, (sel[lineNo] ?? 0) > 0 ? 0 : line.remainingQty)
}

/** "Pilih semua": every selectable line at its full remaining. */
export function selectAll(lines: readonly RefundLine[]): Selection {
  let sel: Selection = EMPTY_SELECTION
  for (const l of lines) sel = setLineQty(lines, sel, l.lineNo, l.remainingQty)
  return sel
}

export const pickedUnits = (sel: Selection): number => Object.values(sel).reduce((a, b) => a + b, 0)

export interface RefundItemInput { lineNo: number; quantity: number }

/** The payload `items`, lowest lineNo first; empty = nothing picked. Only lines that exist and are within their cap. */
export function selectionToItems(lines: readonly RefundLine[], sel: Selection): RefundItemInput[] {
  return lines
    .filter((l) => (sel[l.lineNo] ?? 0) > 0 && (sel[l.lineNo] ?? 0) <= l.remainingQty && lineLockReason(l, lines) === null)
    .map((l) => ({ lineNo: l.lineNo, quantity: sel[l.lineNo] }))
    .sort((a, b) => a.lineNo - b.lineNo)
}

export interface RefundAmount {
  amount: number
  /** This refund returns the last unit: the amount is what the order still has left. */
  settlesRemainder: boolean
}

/** What to pay the customer for this selection: each line at its net share (`cum(prior+k) - cum(prior)`). When the
 *  refund returns the last remaining unit of the order it pays `total - paid so far` so the refunds add up exactly,
 *  but NEVER more than the sum of the picked units' own shares: "paid so far" is the larger of the server row and this
 *  tablet's cache (not their union), so it can understate earlier payouts and must not be allowed to overpay. */
export function refundAmountFor(basis: Extract<RefundBasis, { kind: 'lines' }>, sel: Selection): RefundAmount {
  const items = selectionToItems(basis.lines, sel)
  let sum = 0
  for (const it of items) {
    const l = basis.lines.find((x) => x.lineNo === it.lineNo) as RefundLine
    sum += refundAmountForUnits(l.net, l.soldQty, l.refundedQty, it.quantity)
  }
  const picked = new Map(items.map((i) => [i.lineNo, i.quantity]))
  const settles = items.length > 0 && basis.lines.every((l) => l.remainingQty - (picked.get(l.lineNo) ?? 0) === 0)
  return { amount: settles ? Math.min(sum, Math.max(0, basis.total - basis.priorAmount)) : sum, settlesRemainder: settles }
}

/** Sold - refunded for the whole order, for the "Sebagian direfund" chip. */
export function remainingAmount(basis: Extract<RefundBasis, { kind: 'lines' }>): number {
  return Math.max(0, basis.total - basis.priorAmount)
}

/** Every unit of every line is already refunded. */
export const isExhausted = (basis: RefundBasis): boolean => basis.kind === 'lines' && basis.lines.every((l) => l.remainingQty === 0)

export interface ReasonPreset { code: string; label: string }

/** D-43. The slugs match the backoffice refund form, so reports group the same way. */
export const REASON_PRESETS: readonly ReasonPreset[] = [
  { code: 'rusak_cacat', label: 'Rusak/cacat' },
  { code: 'salah_varian', label: 'Salah varian' },
  { code: 'berubah_pikiran', label: 'Berubah pikiran' },
  { code: 'tidak_cocok_alergi', label: 'Tidak cocok/alergi' },
  { code: 'lainnya', label: 'Lainnya' },
]

export type ReasonResult = { ok: true; reason: string; reasonCode: string } | { ok: false; error: string }

/** The preset label (or the typed text for "Lainnya") plus its slug. */
export function buildReason(code: string | null, freeText: string): ReasonResult {
  const preset = REASON_PRESETS.find((p) => p.code === code)
  if (!preset) return { ok: false, error: 'Pilih alasan refund' }
  if (preset.code === 'lainnya') {
    const t = freeText.trim()
    if (!t) return { ok: false, error: 'Alasan refund wajib diisi' }
    if ([...t].length > MAX_REFUND_REASON_CHARS) return { ok: false, error: `Alasan refund maksimal ${MAX_REFUND_REASON_CHARS} karakter` }
    return { ok: true, reason: t, reasonCode: preset.code }
  }
  return { ok: true, reason: preset.label, reasonCode: preset.code }
}
