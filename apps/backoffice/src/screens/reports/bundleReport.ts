import type { components } from '@mandalika/api'

export type BundleReport = components['schemas']['BundleReport']
export type BundleReportRow = BundleReport['data'][number]

/** The query the tab sends: empty values are left out, so an unset outlet means "all my outlets". */
export function bundleReportParams(dateFrom: string, dateTo: string, outletId: string): { dateFrom?: string; dateTo?: string; outletId?: string } {
  return {
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(outletId ? { outletId } : {}),
  }
}

/** "Extrait" / "Parfum Intense"; a test-catalog bundle with no ERP line reads "Standar". */
export function bundleLineText(row: Pick<BundleReportRow, 'line' | 'lineLabel'>): string {
  return row.lineLabel || row.line || 'Standar'
}

/** Totals of the rows shown, so the footer row always adds up to the table. */
export function sumBundleRows(rows: readonly BundleReportRow[]): { bundles: number; revenue: number; discount: number } {
  return rows.reduce(
    (t, r) => ({ bundles: t.bundles + r.bundles, revenue: t.revenue + r.revenue, discount: t.discount + r.discount }),
    { bundles: 0, revenue: 0, discount: 0 },
  )
}
