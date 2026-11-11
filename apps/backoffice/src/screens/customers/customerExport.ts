import type { Customer } from '@mandalika/api'
import type { CustomerSort } from './customerRoute'

export interface CustomerFilterState {
  q: string
  sort: CustomerSort
  tagId: string
  segmentId: string
}

/** The filters an export honours, in plain words (the Unduh tooltip and the file name). */
export function describeCustomerFilters(
  f: CustomerFilterState,
  tagName: (id: string) => string | undefined,
  segmentName: (id: string) => string | undefined,
): string[] {
  return [
    ...(f.q.trim() ? [`Cari: ${f.q.trim()}`] : []),
    ...(f.tagId ? [`Tag: ${tagName(f.tagId) ?? 'tidak dikenal'}`] : []),
    ...(f.segmentId ? [`Segmen: ${segmentName(f.segmentId) ?? 'tidak dikenal'}`] : []),
    ...(f.sort !== 'belanja' ? ['Urutan: Terbaru'] : []),
  ]
}

/**
 * The sort an export pages with. Spend changes with every sale, so paging by offset over it can
 * skip a customer who crosses a page boundary, and a skip leaves the total unchanged (the
 * completeness check cannot see it). Creation order has immutable keys; the rows are sorted by
 * spend in the browser afterwards (sortBySpend).
 */
export function exportPageSort(sort: CustomerSort): CustomerSort {
  return sort === 'belanja' ? 'terbaru' : sort
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/

/**
 * An RFC3339 instant as [milliseconds, microseconds within the millisecond]: Date keeps only
 * milliseconds, and the server orders by the microsecond timestamp. Digits past the sixth are
 * dropped (Postgres stores microseconds). An unparsable string sorts as the oldest instant.
 */
export function createdAtKey(s: string): [number, number] {
  const m = RFC3339.exec(s)
  if (!m) return [Number.NEGATIVE_INFINITY, 0]
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6)
  const ms = Date.parse(`${m[1]}.${frac.slice(0, 3)}${m[3]}`)
  if (Number.isNaN(ms)) return [Number.NEGATIVE_INFINITY, 0]
  return [ms, Number(frac.slice(3))]
}

/**
 * The server's spend order, totalSpent DESC, createdAt DESC, id DESC, applied to a complete
 * fetch. Returns a new array. Ids compare as lowercase UUID strings, which matches Postgres
 * uuid (byte) order.
 */
export function sortBySpend(rows: readonly Customer[]): Customer[] {
  return rows
    .map((c) => ({ c, k: createdAtKey(c.createdAt), id: (c.id ?? '').toLowerCase() }))
    .sort((a, b) => {
      if (a.c.totalSpent !== b.c.totalSpent) return b.c.totalSpent - a.c.totalSpent
      if (a.k[0] !== b.k[0]) return a.k[0] < b.k[0] ? 1 : -1
      if (a.k[1] !== b.k[1]) return b.k[1] - a.k[1]
      return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
    })
    .map((x) => x.c)
}

/** One export row per customer: the columns the old unfiltered export had. */
export function customerExportRows(rows: readonly Customer[]) {
  return rows.map((c) => ({
    Nama: c.name,
    Telepon: c.phone,
    Email: c.email ?? '',
    Poin: c.points,
    'Total Belanja': c.totalSpent,
    'Jumlah Kunjungan': c.visitCount,
    Tag: (c.tags ?? []).map((t) => t.name).join(', '),
    Segmen: c.segment?.name ?? '',
  }))
}
