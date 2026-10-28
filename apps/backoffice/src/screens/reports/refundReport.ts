import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { RefundReportRow } from '@mandalika/api'

export type RefundFlagFilter = '' | 'any' | 'amount_mismatch' | 'over_total'
export type RefundBadgeTone = 'success' | 'warning' | 'danger' | 'neutral'

export const REFUND_FLAG_OPTIONS: { value: RefundFlagFilter; label: string }[] = [
  { value: '', label: 'Semua' },
  { value: 'any', label: 'Ada peringatan' },
  { value: 'amount_mismatch', label: 'Jumlah beda' },
  { value: 'over_total', label: 'Melebihi total' },
]

const SCOPE_LABEL: Record<string, string> = {
  full: 'Penuh',
  partial: 'Sebagian',
  legacy_full: 'Penuh (lama)',
}

const FLAG_LABEL: Record<string, string> = {
  amount_mismatch: 'Jumlah beda',
  over_total: 'Melebihi total',
}

export function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope] ?? scope
}

/** Label for a server amountWarning; '' when there is none. Unknown flags pass through. */
export function flagLabel(flag: string | null | undefined): string {
  if (!flag) return ''
  return FLAG_LABEL[flag] ?? flag
}

/** over_total is the severe one (the sale was refunded for more than it was worth). */
export function flagTone(flag: string | null | undefined): RefundBadgeTone {
  if (!flag) return 'neutral'
  return flag === 'over_total' ? 'danger' : 'warning'
}

type Item = RefundReportRow['items'][number]

/** "Nama (ukuran) ×qty, ..." — the variant is dropped when blank. Empty list -> ''. */
export function itemSummary(items: Item[] | null | undefined): string {
  return (items ?? [])
    .map((i) => `${i.productName}${i.variantSize ? ` (${i.variantSize})` : ''} ×${i.quantity}`)
    .join(', ')
}

export function totalQuantity(items: Item[] | null | undefined): number {
  return (items ?? []).reduce((n, i) => n + i.quantity, 0)
}

/** The tablet's claimed amount, only when it differs from the amount of record; else null. */
export function claimedIfDifferent(r: Pick<RefundReportRow, 'amount' | 'claimedAmount'>): number | null {
  return r.claimedAmount != null && r.claimedAmount !== r.amount ? r.claimedAmount : null
}

export function formatRefundTime(iso: string): string {
  return format(parseISO(iso), 'dd/MM/yyyy HH:mm', { locale: idLocale })
}

/** The refund CSV: one row per refund (single format for Laporan > Refund and Ekspor). */
export function refundCsvRows(rows: RefundReportRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    'No. struk': r.orderNumber,
    'Refund ke-': r.seq,
    Waktu: formatRefundTime(r.refundedAt),
    'Hari refund': r.refundBusinessDate ?? '',
    Item: itemSummary(r.items),
    Qty: r.items.length > 0 ? totalQuantity(r.items) : '',
    Jumlah: r.amount,
    'Jumlah diklaim': claimedIfDifferent(r) ?? '',
    Metode: r.paymentMethod,
    Oleh: r.refundedByName ?? '',
    Kasir: r.cashierName,
    Outlet: r.outletName,
    Alasan: r.reason,
    'Kode alasan': r.reasonCode ?? '',
    'Peringatan jumlah': flagLabel(r.amountWarning),
  }))
}
