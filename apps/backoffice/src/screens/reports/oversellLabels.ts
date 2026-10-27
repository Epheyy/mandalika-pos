import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import type { OversellRecord, OversellReport } from '@mandalika/api'

/** Browser event fired after lines are marked "sudah dicek" so the badge refreshes at once. */
export const OVERSELL_CHANGED = 'mandalika:oversell-changed'

export const KIND_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua jenis' },
  { id: 'shortage', label: 'Stok kurang' },
  { id: 'unresolved_variant', label: 'Varian tidak ditemukan' },
  { id: 'refund_unresolved_variant', label: 'Refund varian dihapus' },
]

export const STATUS_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '', label: 'Semua status' },
  { id: 'open', label: 'Belum dicek' },
  { id: 'acknowledged', label: 'Sudah dicek' },
]

const KIND_LABEL: Record<string, string> = {
  shortage: 'Stok kurang',
  unresolved_variant: 'Varian tidak ditemukan',
  refund_unresolved_variant: 'Refund varian dihapus',
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

export function channelLabel(channel: string): string {
  return channel === 'sync' ? 'Sinkron tablet' : 'Langsung'
}

export function orderStatusLabel(status: string): string {
  if (status === 'completed') return 'Selesai'
  if (status === 'partially_refunded') return 'Sebagian refund'
  if (status === 'refunded') return 'Direfund'
  if (status === 'cancelled') return 'Dibatalkan'
  return status
}

/** Sold-at to recorded-at gap: how long the tablet held the sale before the server applied it. */
export function syncLagLabel(soldAt: string, recordedAt: string): string {
  const ms = parseISO(recordedAt).getTime() - parseISO(soldAt).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return '—'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} mnt`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours} jam`
  return `${Math.round(hours / 24)} hari`
}

/** "110ml" style size when present; the unresolved kinds still carry the sale-time size. */
export function lineLabel(r: Pick<OversellRecord, 'productName' | 'variantSize'>): string {
  return r.variantSize ? `${r.productName} · ${r.variantSize}` : r.productName
}

const fmt = (iso: string) => format(parseISO(iso), 'dd/MM/yyyy HH:mm', { locale: idLocale })

/** Indonesian-header CSV rows. Stock cells stay numbers (negative stock must not become text). */
export function oversellCsvRows(rows: ReadonlyArray<OversellRecord>): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    'Waktu Jual': fmt(r.soldAt),
    'Waktu Sinkron': fmt(r.recordedAt),
    'No. Transaksi': r.orderNumber,
    Status: orderStatusLabel(r.orderStatus),
    Outlet: r.outletName,
    Produk: r.productName,
    Ukuran: r.variantSize,
    SKU: r.sku ?? '',
    Jenis: kindLabel(r.kind),
    Qty: r.quantity,
    'Stok Sebelum': r.stockBefore ?? '',
    'Stok Sesudah': r.stockAfter ?? '',
    Kekurangan: r.shortfall,
    'Stok Saat Ini': r.currentStock ?? '',
    Kasir: r.cashierName,
    Jalur: channelLabel(r.channel),
    Dicek: r.acknowledgedAt ? 'Ya' : 'Belum',
    'Dicek Oleh': r.acknowledgedByName ?? '',
    Catatan: r.acknowledgeNote ?? '',
  }))
}

export const EXPORT_PAGE_SIZE = 200
export const EXPORT_MAX_ROWS = 5000

/** Pages through the report for an export. `truncated` is true when more rows exist than the cap. */
export async function collectOversellForExport(
  fetchPage: (page: number, limit: number) => Promise<OversellReport>,
): Promise<{ rows: OversellRecord[]; truncated: boolean }> {
  const rows: OversellRecord[] = []
  for (let page = 1; rows.length < EXPORT_MAX_ROWS; page++) {
    const r = await fetchPage(page, EXPORT_PAGE_SIZE)
    rows.push(...r.data)
    if (r.data.length === 0 || rows.length >= r.meta.total) return { rows, truncated: false }
  }
  return { rows: rows.slice(0, EXPORT_MAX_ROWS), truncated: true }
}
