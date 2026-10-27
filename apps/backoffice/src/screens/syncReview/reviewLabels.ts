import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'

const REASONS: Record<string, string> = {
  forbidden: 'Ditolak: tidak berwenang / PIN salah',
  actor_mismatch: 'Dibuat oleh akun lain',
  offline_expired: 'Offline lebih dari 12 jam',
  competing_receipt: 'Transfer sudah diterima tablet lain',
  rejected: 'Ditolak server',
  conflict: 'Ditolak server',
  batch_rejected: 'Kiriman ditolak',
  sale_in_review: 'Penjualan asal refund sedang ditinjau',
}

/** Reason filter options; 'none' = parked by old attempt counting (server filter value). */
export const REASON_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua alasan' },
  { id: 'forbidden', label: REASONS.forbidden },
  { id: 'actor_mismatch', label: REASONS.actor_mismatch },
  { id: 'offline_expired', label: REASONS.offline_expired },
  { id: 'competing_receipt', label: REASONS.competing_receipt },
  { id: 'rejected', label: 'Ditolak server (rejected)' },
  { id: 'conflict', label: 'Ditolak server (conflict)' },
  { id: 'batch_rejected', label: REASONS.batch_rejected },
  { id: 'sale_in_review', label: REASONS.sale_in_review },
  { id: 'none', label: 'Gagal berulang (versi lama)' },
]

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return 'Gagal berulang (versi lama)'
  return REASONS[code] ?? `Ditolak (${code})`
}

/** The server's refund review texts (backend/internal/service/refund_input.go) all end with the
 *  same "jangan bayar ulang" warning and ride in reviewReason/lastError, not in reviewCode (that
 *  is the generic conflict/rejected). Matched by their stable lead phrase, longest-specific first. */
const REFUND_DO_NOT_PAY_AGAIN = 'Jika uang sudah dikembalikan, jangan bayar ulang.'
const REFUND_REASONS: ReadonlyArray<{ match: string; label: string }> = [
  { match: 'melebihi sisa barang', label: 'Refund melebihi sisa barang yang belum direfund (bisa jadi refund ganda)' },
  { match: 'Sebagian transaksi ini sudah direfund dari tablet lain', label: 'Tablet versi lama me-refund transaksi yang sebagian sudah direfund; perbarui aplikasi lalu refund sisa barang' },
  { match: 'promo paket/beli-gratis', label: 'Barang promo paket/beli-gratis harus direfund bersamaan seluruhnya' },
  { match: 'Transaksi lama hanya bisa direfund seluruhnya', label: 'Transaksi lama hanya bisa direfund seluruhnya' },
  { match: 'tidak dikenal, ganda', label: 'Baris barang refund tidak dikenal, ganda, atau jumlahnya tidak valid' },
  { match: 'Kode alasan refund tidak valid', label: 'Kode alasan refund tidak valid' },
]

/** Short readable label for a refund review text, with the do-not-pay-again note kept whenever the
 *  server text carried it. null = not a known refund text (show the raw text instead). */
export function refundReviewLabel(text: string | null | undefined): string | null {
  if (!text) return null
  const hit = REFUND_REASONS.find((r) => text.includes(r.match))
  if (!hit) return null
  return text.includes(REFUND_DO_NOT_PAY_AGAIN) ? `${hit.label}. ${REFUND_DO_NOT_PAY_AGAIN}` : hit.label
}

const AMOUNT_FLAGS: Record<string, string> = {
  amount_mismatch: 'Jumlah refund dari tablet berbeda dengan hitungan server (informasi; tercatat sesuai hitungan server)',
  over_total: 'Jumlah refund dari tablet melebihi sisa transaksi (informasi; tercatat maksimal sisa transaksi)',
}

export function amountFlagLabel(flag: string | null | undefined): string | null {
  return flag ? (AMOUNT_FLAGS[flag] ?? null) : null
}

const TYPES: Record<string, string> = {
  order: 'Penjualan',
  refund: 'Refund',
  shift_open: 'Buka shift',
  shift_close: 'Tutup shift',
  cash_flow: 'Kas masuk/keluar',
  customer_create: 'Pelanggan baru',
  transfer_receive: 'Terima transfer',
}

export function typeLabel(t: string): string {
  return TYPES[t] ?? t
}

export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export function isStale(lastReportedAt: string, now: number = Date.now()): boolean {
  return now - Date.parse(lastReportedAt) > STALE_AFTER_MS
}

/** Browser-local time; the backoffice runs in WIB (same convention as ErrorLogs). */
export function fmtWib(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return format(parseISO(iso), 'dd MMM yyyy HH:mm', { locale: id })
  } catch {
    return iso
  }
}

const idr = (n: unknown) =>
  typeof n === 'number' ? n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }) : '—'
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '—')

function itemsLine(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '—'
  return v
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>
      const name = str(o.productName ?? o.name ?? o.productId)
      const size = typeof o.variantSize === 'string' ? ` ${o.variantSize}` : ''
      const qty = o.quantity ?? o.qty ?? o.receivedQty
      return `${name}${size} × ${typeof qty === 'number' ? qty : '?'}`
    })
    .join(', ')
}

function refundItemsLine(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return 'Semua barang (refund seluruhnya)'
  return v
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>
      const line = typeof o.lineNo === 'number' ? `Baris ${o.lineNo}` : str(o.productName ?? o.name)
      const name = typeof o.lineNo === 'number' && typeof (o.productName ?? o.name) === 'string' ? ` (${String(o.productName ?? o.name)})` : ''
      return `${line}${name} × ${typeof o.quantity === 'number' ? o.quantity : '?'}`
    })
    .join(', ')
}

/** Human summary of a review item's payload, per type. Unknown types → []. */
export function payloadSummary(type: string, p: Record<string, unknown>): Array<[string, string]> {
  switch (type) {
    case 'refund':
      return [
        ['Struk', str(p.orderNumber)],
        ['Barang', refundItemsLine(p.items)],
        ['Jumlah', idr(p.refundAmount ?? p.total)],
        ['Metode', str(p.paymentMethod)],
        ['Alasan', str(p.reason)],
      ]
    case 'order':
      return [['Struk', str(p.orderNumber)], ['Barang', itemsLine(p.items)], ['Metode', str(p.paymentMethod)], ['Dibayar', idr(p.amountPaid)]]
    case 'shift_open':
      return [['Kas awal', idr(p.startingCash)]]
    case 'shift_close':
      return [['Kas akhir', idr(p.closingCash)]]
    case 'cash_flow':
      return [['Jenis', str(p.type)], ['Jumlah', idr(p.amount)], ['Keterangan', str(p.description)]]
    case 'customer_create':
      return [['Nama', str(p.name)], ['Telepon', str(p.phone)]]
    case 'transfer_receive':
      return [['Transfer', str(p.transferId)], ['Barang', itemsLine(p.items)], ['Selisih', str(p.discrepancyReason)]]
    default:
      return []
  }
}

/** True when a page past the first came back empty (its last row was resolved, possibly by
 *  another user): step back instead of showing an empty state next to a non-zero open count. */
export function shouldStepBack(s: { loading: boolean; error: string | null; rowCount: number; page: number }): boolean {
  return !s.loading && !s.error && s.rowCount === 0 && s.page > 1
}
