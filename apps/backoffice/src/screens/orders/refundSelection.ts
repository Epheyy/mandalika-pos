/** Pure logic for the admin per-line refund form and the order-detail refund display (C4c, D-34/D-41/D-43/D-47/D-49). */

export interface RefundableItem {
  lineNo?: number | null
  productName?: string
  variantSize?: string
  quantity: number
  refundedQty?: number
  refundGroup?: string | null
  price: number
  netAmount?: number | null
}

/** lineNo -> quantity picked. Absent / 0 = not selected. */
export type Selection = Readonly<Record<number, number>>

export const EMPTY_SELECTION: Selection = {}

export interface ReasonPreset {
  code: string
  label: string
}

export const REASON_PRESETS: readonly ReasonPreset[] = [
  { code: 'rusak_cacat', label: 'Rusak/cacat' },
  { code: 'salah_varian', label: 'Salah varian' },
  { code: 'berubah_pikiran', label: 'Berubah pikiran' },
  { code: 'tidak_cocok_alergi', label: 'Tidak cocok/alergi' },
  { code: 'lainnya', label: 'Lainnya' },
]

const REASON_CODE_RE = /^[a-z0-9_-]+$/

export const remainingQty = (it: RefundableItem): number =>
  Math.max(0, it.quantity - (it.refundedQty ?? 0))

const groupMembers = (items: readonly RefundableItem[], group: string): RefundableItem[] =>
  items.filter((i) => i.refundGroup === group)

/** Why a line cannot be picked (null = selectable). */
export function lineLockReason(it: RefundableItem, items: readonly RefundableItem[]): string | null {
  if (it.lineNo == null) return 'Transaksi lama: hanya refund seluruh transaksi'
  if (remainingQty(it) === 0) return 'Sudah direfund semua'
  if (it.refundGroup) {
    const members = groupMembers(items, it.refundGroup)
    if (members.some((m) => m.lineNo == null)) return 'Transaksi lama: hanya refund seluruh transaksi'
    if (members.some((m) => (m.refundedQty ?? 0) > 0)) {
      return 'Paket/grup sudah sebagian direfund, tidak bisa dipilih sebagian'
    }
  }
  return null
}

/** Set one line's picked quantity: clamps to 0..remaining; a grouped line selects/clears the whole group
 *  at each member's full remaining qty (all-or-nothing). A locked line leaves the selection unchanged. */
export function setLineQty(
  items: readonly RefundableItem[],
  sel: Selection,
  lineNo: number,
  qty: number,
): Selection {
  const it = items.find((i) => i.lineNo === lineNo)
  if (!it || lineLockReason(it, items) !== null) return sel
  const next: Record<number, number> = { ...sel }
  if (it.refundGroup) {
    const on = qty > 0
    for (const m of groupMembers(items, it.refundGroup)) {
      if (m.lineNo == null) continue
      if (on) next[m.lineNo] = remainingQty(m)
      else delete next[m.lineNo]
    }
    return next
  }
  const clamped = Math.min(remainingQty(it), Math.max(0, Math.floor(qty)))
  if (clamped === 0) delete next[lineNo]
  else next[lineNo] = clamped
  return next
}

/** Items payload for api.refundOrder; empty = nothing picked (submit blocked). */
export function selectionToItems(sel: Selection): { lineNo: number; quantity: number }[] {
  return Object.entries(sel)
    .map(([k, q]) => ({ lineNo: Number(k), quantity: q }))
    .filter((x) => x.quantity > 0)
    .sort((a, b) => a.lineNo - b.lineNo)
}

/** Approximate refund: net share per picked unit. The server computes the exact amount and caps it (D-49). */
export function estimateRefund(items: readonly RefundableItem[], sel: Selection): number {
  let sum = 0
  for (const it of items) {
    if (it.lineNo == null) continue
    const picked = sel[it.lineNo] ?? 0
    if (picked <= 0 || it.quantity <= 0) continue
    const lineNet = it.netAmount ?? it.price * it.quantity
    sum += (lineNet * picked) / it.quantity
  }
  return Math.round(sum)
}

export type ReasonResult =
  | { ok: true; reason: string; reasonCode: string }
  | { ok: false; error: string }

/** Preset label (or free text for Lainnya) + slug. */
export function buildReason(code: string, freeText: string): ReasonResult {
  const preset = REASON_PRESETS.find((p) => p.code === code)
  if (!preset || !REASON_CODE_RE.test(preset.code)) return { ok: false, error: 'Pilih alasan refund' }
  if (preset.code === 'lainnya') {
    const t = freeText.trim()
    if (!t) return { ok: false, error: 'Alasan refund wajib diisi' }
    return { ok: true, reason: t, reasonCode: preset.code }
  }
  return { ok: true, reason: preset.label, reasonCode: preset.code }
}

/** Per-line refund form is offered for completed / partially refunded orders that have refundable lines. */
export const canPartialRefundStatus = (status: string): boolean =>
  status === 'completed' || status === 'partially_refunded'

/** Remaining refundable money; null when it cannot be known (older server on a part-refunded order). */
export function remainingRefundable(o: { status: string; total: number; refundedAmount?: number }): number | null {
  if (o.refundedAmount !== undefined) return Math.max(0, o.total - o.refundedAmount)
  if (o.status === 'refunded') return 0
  if (o.status === 'completed') return o.total
  return null
}

export const refundScopeLabel = (scope: string): string =>
  scope === 'partial' ? 'Refund sebagian' : scope === 'full' ? 'Refund sisa/seluruhnya' : 'Refund seluruh transaksi'

export const refundFlagLabel = (flag?: string | null): string | null =>
  flag === 'amount_mismatch' ? 'Jumlah beda' : flag === 'over_total' ? 'Melebihi total' : flag ? flag : null

export const UNCERTAIN_REFUND_MESSAGE =
  'Hasil refund belum pasti: data transaksi dimuat ulang, periksa daftar refund sebelum mengulang.'

/** True when the refund outcome is unknown (network error / 5xx): the caller must reload before retrying. */
export const isUncertainRefundStatus = (status: number | undefined): boolean =>
  status === undefined || status === 0 || status >= 500

/** Readable message for a failed refund call. */
export function refundErrorMessage(status: number | undefined, message: string): string {
  // The 409 text from the server carries a "jangan bayar ulang" warning: keep it.
  if (status === 409) return message || 'Ada refund lain yang baru saja terjadi pada transaksi ini. Data dimuat ulang, silakan cek lagi.'
  if (isUncertainRefundStatus(status)) return UNCERTAIN_REFUND_MESSAGE
  if (status === 400) return message || 'Permintaan refund tidak valid.'
  return message || 'Gagal memproses refund.'
}
