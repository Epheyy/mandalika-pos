import type { SalesPerformanceRow, SalesRating } from '@mandalika/api'

/** Page size of the rating drill-down (fixed, like the other report pagers). */
export const RATINGS_PAGE_SIZE = 20

export const RATING_TAG_LABELS: Record<string, string> = {
  ramah: 'Ramah',
  membantu: 'Membantu',
  paham_produk: 'Paham produk',
  cepat: 'Cepat',
}

/** Label of a tag code; an unknown code is shown as it came. */
export const ratingTagLabel = (code: string): string => RATING_TAG_LABELS[code] ?? code

export const FLAG_HINT =
  'Dinilai < 60 detik setelah dikirim atau dari jaringan yang sama dengan tablet - periksa kemungkinan penilaian oleh staf sendiri'

/** "2026-11" for a YYYY-MM-DD day, '' when it is not one. */
export function monthOfDay(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(0, 7) : ''
}

/** First and last day of a YYYY-MM month (null for anything else). */
export function monthRange(ym: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym)
  if (!m) return null
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

/** 0.4286 -> "43%". */
export const percentText = (rate: number): string => `${Math.round((Number.isFinite(rate) ? rate : 0) * 100)}%`

/** 4.256 -> "4,3"; absent (no ratings) -> "-". */
export function avgText(avg: number | undefined | null): string {
  if (avg == null || !Number.isFinite(avg)) return '-'
  return avg.toFixed(1).replace('.', ',')
}

/** Share of each star level (index 0 = 1 star) as whole-number widths; all 0 when nothing was rated. */
export function starShares(counts: readonly number[]): number[] {
  const five = Array.from({ length: 5 }, (_, i) => Math.max(0, counts[i] ?? 0))
  const total = five.reduce((a, b) => a + b, 0)
  return total === 0 ? five.map(() => 0) : five.map((c) => (c / total) * 100)
}

export const salesmanLabel = (r: Pick<SalesPerformanceRow, 'salesmanId' | 'salesmanName'>): string =>
  r.salesmanId ? r.salesmanName : 'Tanpa sales'

/** The `salesmanId` filter of listSalesRatings for a report row: a uuid, or "none" for the Tanpa sales row. */
export const ratingsSalesmanFilter = (r: Pick<SalesPerformanceRow, 'salesmanId'>): string => r.salesmanId ?? 'none'

export function ratingsParams(o: {
  dateFrom: string; dateTo: string; outletId: string; salesmanId: string; flaggedOnly: boolean; page: number
}): Record<string, string | number | boolean> {
  const p: Record<string, string | number | boolean> = {
    dateFrom: o.dateFrom, dateTo: o.dateTo, salesmanId: o.salesmanId, page: o.page, limit: RATINGS_PAGE_SIZE,
  }
  if (o.outletId) p.outletId = o.outletId
  if (o.flaggedOnly) p.flaggedOnly = true
  return p
}

/** Flag chips of one rating, in a stable order. */
export function ratingFlags(r: Pick<SalesRating, 'flagFast' | 'flagSameNetwork'>): string[] {
  return [r.flagFast ? 'Cepat (< 60 detik)' : '', r.flagSameNetwork ? 'Jaringan sama' : ''].filter(Boolean)
}
