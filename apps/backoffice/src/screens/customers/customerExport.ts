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
