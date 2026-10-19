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

/** Human summary of a review item's payload, per type. Unknown types → []. */
export function payloadSummary(type: string, p: Record<string, unknown>): Array<[string, string]> {
  switch (type) {
    case 'refund':
      return [['Struk', str(p.orderNumber)], ['Jumlah', idr(p.total)], ['Metode', str(p.paymentMethod)], ['Alasan', str(p.reason)]]
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
