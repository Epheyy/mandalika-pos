import { localDay } from '../../lib/businessDay'
import { LEDGER_BUCKET, LEDGER_KIND } from '../../lib/labels/ledger'

export const MOVEMENT_KINDS = [
  'sale', 'refund', 'transfer_out', 'transfer_in', 'transfer_cancel', 'receipt', 'adjust', 'count', 'opening', 'write_off',
] as const

export type MovementKind = (typeof MOVEMENT_KINDS)[number]

export const MOVEMENT_KIND_LABEL: Record<MovementKind, string> = {
  sale: LEDGER_KIND.sale.label,
  refund: LEDGER_KIND.refund.label,
  transfer_out: LEDGER_KIND.transfer_out.label,
  transfer_in: LEDGER_KIND.transfer_in.label,
  transfer_cancel: LEDGER_KIND.transfer_cancel.label,
  receipt: LEDGER_KIND.receipt.label,
  adjust: LEDGER_KIND.adjust.label,
  count: LEDGER_KIND.count.label,
  opening: LEDGER_KIND.opening.label,
  write_off: LEDGER_KIND.write_off.label,
}

export type KindBucket = keyof typeof LEDGER_BUCKET

/**
 * The ledger kinds under the six Pergerakan bucket names, for the Kartu Stok filter chips. Display only: the
 * filter still sends the kinds. A Transfer Masuk counts as Masuk in Pergerakan when a warehouse sent it to an
 * outlet and as Transfer otherwise; the server decides per row, so the chip sits under Transfer. Hadiah is a flag
 * on a sale (giveaway), not a kind, so it has no kind chips.
 */
export const KIND_GROUPS: ReadonlyArray<{ bucket: KindBucket; kinds: readonly MovementKind[] }> = [
  { bucket: 'masuk', kinds: ['receipt'] },
  { bucket: 'penjualan', kinds: ['sale'] },
  { bucket: 'refund', kinds: ['refund'] },
  { bucket: 'transfer', kinds: ['transfer_out', 'transfer_in', 'transfer_cancel'] },
  { bucket: 'penyesuaian', kinds: ['adjust', 'count', 'write_off', 'opening'] },
  { bucket: 'hadiah', kinds: [] },
]

/** What the Dokumen cell reads for a ledger ref without a number (a goods receipt has none). Never the raw ref type. */
const REF_TYPE_LABEL: Readonly<Record<string, string>> = {
  goods_receipt: 'Dokumen barang masuk',
  stock_adjustment: 'Dokumen penyesuaian',
  transfer: 'Dokumen transfer',
  stock_count: 'Dokumen opname',
  order: 'Transaksi',
}

export function refTypeLabel(refType: string): string {
  return Object.prototype.hasOwnProperty.call(REF_TYPE_LABEL, refType) ? REF_TYPE_LABEL[refType] : 'Dokumen'
}

/** Short month names as date-fns `id` prints them elsewhere in the app (Agt, not Intl's Agu). */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des']

/** An instant as `04 Nov 2026 · 14:22` in the location's timezone (same month names as Opname and Persetujuan). */
export function formatMovementTime(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: zone,
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('day')} ${MONTHS_SHORT[Number(get('month')) - 1] ?? ''} ${get('year')} · ${get('hour')}:${get('minute')}`
}

/** A quantity with its direction: `+9`, `−1` (true minus sign); empty for zero. */
/** State of the SKU picker the moment a new query starts: the previous results are dropped so they cannot be picked while the new answer loads. */
export function skuSearchStart<T>(): { results: T[]; status: 'loading'; active: -1 } {
  return { results: [], status: 'loading', active: -1 }
}

export function signedQty(qty: number): string {
  if (qty === 0) return ''
  return `${qty > 0 ? '+' : '−'}${Math.abs(qty).toLocaleString('id-ID')}`
}

/** Only inbound movements (transfer in, goods receipt) read green in the Jenis pill, as in the mock; the rest stay neutral. */
const INBOUND_KINDS: ReadonlySet<string> = new Set(['transfer_in', 'receipt'])
export const movementKindTone = (kind: string): 'ok' | 'neutral' => (INBOUND_KINDS.has(kind) ? 'ok' : 'neutral')

/** A day as YYYY-MM-DD in the location timezone. */
function dayInZone(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: zone })
}

/** Recorded on a later business day than it occurred (an offline sale synced days later). */
export function isRecordedLate(occurredAt: string, recordedAt: string, zone: string): boolean {
  return dayInZone(occurredAt, zone) < dayInZone(recordedAt, zone)
}

export function daysAgoDay(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDay(d)
}
