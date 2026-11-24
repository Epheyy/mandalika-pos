import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { VoidReport, VoidReportRow } from '@mandalika/api'
import { VOID_REASONS, voidReasonLabel } from '../../lib/labels/void'
import { csvDateTime } from '../orderTimes'

type Tender = VoidReportRow['originalTenders'][number]
type ReasonTotal = VoidReport['byReason'][number]

const amountText = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(n)

/** Status of a row: diganti | menunggu pengganti | tanpa pengganti | Dibatalkan (impor lama). */
export function voidStateLabel(r: Pick<VoidReportRow, 'state'>): string {
  switch (r.state) {
    case 'replaced': return 'diganti'
    case 'awaiting_replacement': return 'menunggu pengganti'
    case 'no_replacement': return 'tanpa pengganti'
    default: return 'Dibatalkan (impor lama)'
  }
}

/** A replacement that was itself voided no longer counts as money corrected (the server leaves it out of
 *  totals.replacementTotal and sets replacementStanding false on the row). */
export function replacementVoided(r: Pick<VoidReportRow, 'replacementOrderNumber' | 'replacementStanding'>): boolean {
  return !!r.replacementOrderNumber && r.replacementStanding === false
}

/** "cash 100.000 + qris 50.000": the raw method ids, as the CSV and the audit trail name them. */
export function tendersText(tenders: readonly Tender[] | undefined): string {
  return (tenders ?? []).map((t) => `${t.method} ${amountText(t.amount)}`).join(' + ')
}

export const VOID_CSV_HEADERS = [
  'No. asli', 'Tanggal', 'Outlet', 'Kasir penjual', 'Alasan', 'Catatan', 'Dibatalkan oleh', 'Perangkat', 'Sumber', 'Waktu batal',
  'Setelah tutup', 'Total asli', 'Metode asli', 'No. pengganti', 'Total pengganti', 'Pengganti berlaku', 'Metode pengganti', 'Penyesuaian koreksi',
  'Barang terhitung opname', 'Status',
] as const

/** One CSV row, in VOID_CSV_HEADERS order. */
export function voidCsvRow(r: VoidReportRow): string[] {
  return [
    r.orderNumber,
    r.businessDate,
    r.outletName,
    r.soldByName,
    r.reasonCode ? voidReasonLabel(r.reasonCode) : '',
    r.note ?? '',
    r.voidedByName ?? '',
    r.deviceId ?? '',
    r.source ?? '',
    csvDateTime(r.voidedAt),
    r.afterClose ? 'ya' : 'tidak',
    String(r.originalTotal),
    tendersText(r.originalTenders),
    r.replacementOrderNumber ?? '',
    r.replacementTotal != null ? String(r.replacementTotal) : '',
    r.replacementOrderNumber ? (replacementVoided(r) ? 'tidak (dibatalkan)' : 'ya') : '',
    tendersText(r.replacementTenders),
    r.correctionAmount != null ? String(r.correctionAmount) : '',
    String(r.countedLines),
    voidStateLabel(r),
  ]
}

/** Records for exportToCSV (header => cell). */
export function voidCsvRecords(rows: readonly VoidReportRow[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(voidCsvRow(r).map((cell, i) => [VOID_CSV_HEADERS[i], cell])))
}

export interface ReasonCard { code: string; label: string; voids: number; originalTotal: number }

/** One card per reason in the server's byReason (which spans the whole filtered range), in the reason list's order. */
export function reasonCards(byReason: readonly ReasonTotal[] | undefined): ReasonCard[] {
  const order = (code: string) => {
    const i = VOID_REASONS.findIndex((r) => r.code === code)
    return i < 0 ? VOID_REASONS.length : i
  }
  return [...(byReason ?? [])]
    .sort((a, b) => order(a.reasonCode) - order(b.reasonCode))
    .map((b) => ({ code: b.reasonCode, label: voidReasonLabel(b.reasonCode), voids: b.voids, originalTotal: b.originalTotal }))
}

export function formatVoidTime(iso: string | undefined): string {
  return iso ? format(parseISO(iso), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '—'
}
