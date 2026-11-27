import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SalesPerformanceReport, SalesRating } from '@mandalika/api'
import { RatingsList, SalesPerformanceView } from './SalesPerformanceTab'

const report = {
  data: [
    {
      salesmanId: 'u1', salesmanName: 'Rina', transactions: 10, revenue: 1500000, receiptsSent: 8, ratingsReceived: 4,
      responseRate: 0.5, avgStars: 4.25, starCounts: [0, 0, 1, 1, 2], flaggedCount: 2,
      latestComments: [
        { stars: 5, comment: 'Ramah sekali', createdAt: '2026-11-20T03:00:00Z' },
        { stars: 3, comment: 'Biasa saja', createdAt: '2026-11-19T03:00:00Z' },
      ],
    },
    {
      salesmanName: '', transactions: 3, revenue: 300000, receiptsSent: 0, ratingsReceived: 0,
      responseRate: 0, starCounts: [0, 0, 0, 0, 0], flaggedCount: 0, latestComments: [],
    },
  ],
  totals: { transactions: 13, revenue: 1800000, receiptsSent: 8, ratingsReceived: 4, responseRate: 0.5, avgStars: 4.25, starCounts: [0, 0, 1, 1, 2], flaggedCount: 2 },
} as unknown as SalesPerformanceReport

const view = (r: SalesPerformanceReport | undefined) =>
  renderToStaticMarkup(<SalesPerformanceView report={r} loading={false} error={null} onRetry={() => {}} onOpen={() => {}} />)

describe('SalesPerformanceTab', () => {
  it('renders the summary strip, one row per salesperson and the Tanpa sales row', () => {
    const out = view(report)
    for (const h of ['Transaksi', 'Pendapatan', 'Struk terkirim', 'Penilaian', 'Respons %', 'Rata-rata ★', 'Ditandai']) expect(out).toContain(h)
    expect(out.match(/<tbody[\s\S]*<\/tbody>/)?.[0].match(/<tr/g)).toHaveLength(2)
    expect(out).toContain('Rina')
    expect(out).toContain('Tanpa sales')
    expect(out).toContain('50%')
    expect(out).toContain('4,3')
    expect(out).toContain('Ramah sekali')
    expect(out).toContain('Dinilai &lt; 60 detik')
  })
  it('shows the empty state without rows', () => {
    const out = view({ data: [], totals: { transactions: 0, revenue: 0, receiptsSent: 0, ratingsReceived: 0, responseRate: 0, starCounts: [0, 0, 0, 0, 0], flaggedCount: 0 } })
    expect(out).toContain('Belum ada penilaian bulan ini.')
  })
})

describe('RatingsList', () => {
  const rating = {
    id: 'r1', orderId: 'o1', orderNumber: 'ORD-9', outletId: 'x', outletName: 'BSD', salesmanName: 'Rina', stars: 2,
    tags: ['cepat', 'ramah'], comment: 'Lama', flagFast: true, flagSameNetwork: false, businessDate: '2026-11-20', createdAt: '2026-11-20T03:00:00Z',
  } as SalesRating
  it('shows stars, tags, comment, order, outlet and flag chips', () => {
    const out = renderToStaticMarkup(<RatingsList rows={[rating]} loading={false} error={null} />)
    for (const s of ['ORD-9', 'BSD', 'Cepat', 'Ramah', 'Lama', 'Cepat (&lt; 60 detik)', '2026-11-20']) expect(out).toContain(s)
    expect(out).not.toContain('Jaringan sama')
  })
  it('shows error and empty states', () => {
    expect(renderToStaticMarkup(<RatingsList rows={[]} loading={false} error="boom" />)).toContain('boom')
    expect(renderToStaticMarkup(<RatingsList rows={[]} loading={false} error={null} />)).toContain('Belum ada penilaian')
  })
})
