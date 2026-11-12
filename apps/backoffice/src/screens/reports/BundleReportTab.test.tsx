import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BundleReportView } from './BundleReportTab'
import { bundleLineText, bundleReportParams, sumBundleRows, type BundleReport } from './bundleReport'

const report = {
  data: [
    { productId: 'p1', productName: 'CHAMPION', line: 'EXTRAIT DE PARFUM', lineLabel: 'Extrait', size: '120ml', bundles: 2, revenue: 1700000, discount: 50000 },
    { productId: 'p1', productName: 'CHAMPION', line: 'PARFUM INTENSE', lineLabel: 'Parfum Intense', size: '120ml', bundles: 1, revenue: 795000, discount: 0 },
    { productId: 'p2', productName: 'NO1', line: '', lineLabel: '', size: '110ml', bundles: 1, revenue: 725000, discount: 0 },
  ],
  totals: { bundles: 4, revenue: 3220000, discount: 50000 },
} as unknown as BundleReport

const html = (r: BundleReport | undefined) =>
  renderToStaticMarkup(<BundleReportView report={r} loading={false} error={null} onRetry={() => {}} />)

describe('BundleReportTab', () => {
  it('renders one row per fragrance, line and size with bundles, revenue and discount', () => {
    const out = html(report)
    for (const h of ['Aroma', 'Lini', 'Ukuran', 'Bundle', 'Pendapatan', 'Diskon']) expect(out).toContain(h)
    expect(out.match(/<tbody[\s\S]*<\/tbody>/)?.[0].match(/<tr/g)).toHaveLength(3)
    expect(out).toContain('Extrait')
    expect(out).toContain('Parfum Intense')
    expect(out).toContain('Standar') // a no-line test bundle
    expect(out).toContain('NO1')
    expect(bundleLineText(report.data[2])).toBe('Standar')
  })

  it('totals row sums the rows', () => {
    expect(sumBundleRows(report.data)).toEqual({ bundles: 4, revenue: 3220000, discount: 50000 })
    const out = html(report)
    expect(out).toContain('bundle-totals')
    expect(out).toContain('Total · 4 bundle')
  })

  it('shows the empty state and no totals row without rows', () => {
    const out = html({ data: [], totals: { bundles: 0, revenue: 0, discount: 0 } })
    expect(out).toContain('Belum ada bundle terjual')
    expect(out).not.toContain('bundle-totals')
  })

  it('date and outlet filters are sent as dateFrom/dateTo/outletId', () => {
    expect(bundleReportParams('2026-11-01', '2026-11-12', 'o1')).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-12', outletId: 'o1' })
    expect(bundleReportParams('2026-11-01', '2026-11-12', '')).toEqual({ dateFrom: '2026-11-01', dateTo: '2026-11-12' })
  })
})
