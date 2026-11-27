import { useState } from 'react'
import type { SalesPerformanceReport, SalesPerformanceRow, SalesRating } from '@mandalika/api'
import { Star } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { Input } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { ReportPager } from './ReportPager'
import {
  FLAG_HINT, RATINGS_PAGE_SIZE, avgText, monthOfDay, monthRange, percentText, ratingFlags, ratingsParams,
  ratingsSalesmanFilter, ratingTagLabel, salesmanLabel, starShares,
} from './salesPerformance'

const money = (n: number) => BRAND.currency.format(n)
const STAR_TONE = ['bg-danger', 'bg-warn', 'bg-paper-2', 'bg-ok/60', 'bg-ok'] as const
const dayText = (iso: string) => iso.slice(0, 10)

/** Compact 5-segment distribution (1 star .. 5 stars), left to right. */
function StarBar({ counts }: { counts: readonly number[] }) {
  const shares = starShares(counts)
  const label = shares.some((s) => s > 0)
    ? counts.slice(0, 5).map((c, i) => `${i + 1} bintang: ${c}`).join(', ')
    : 'Belum ada penilaian'
  return (
    <span role="img" aria-label={label} title={label} className="flex h-2.5 w-28 overflow-hidden rounded-full bg-paper-1">
      {shares.map((s, i) => (s > 0 ? <span key={i} className={STAR_TONE[i]} style={{ width: `${s}%` }} /> : null))}
    </span>
  )
}

const Stars = ({ n }: { n: number }) => (
  <span className="inline-flex items-center gap-0.5 font-bold text-ink-900" aria-label={`${n} bintang`}>
    {n}<Star className="h-3.5 w-3.5 fill-current text-warn" aria-hidden="true" />
  </span>
)

function SalesCell({ row }: { row: SalesPerformanceRow }) {
  return (
    <span className="block min-w-48">
      <span className="font-bold">{salesmanLabel(row)}</span>
      {row.latestComments.slice(0, 3).map((c, i) => (
        <span key={i} className="mt-1 block max-w-sm text-xs text-ink-700">
          <Stars n={c.stars} /> <span className="italic">&ldquo;{c.comment}&rdquo;</span>
          <span className="text-ink-500"> · {dayText(c.createdAt)}</span>
        </span>
      ))}
    </span>
  )
}

const COLUMNS: Column<SalesPerformanceRow>[] = [
  { id: 'sales', header: 'Sales', cell: (r) => <SalesCell row={r} /> },
  { id: 'trx', header: 'Transaksi', align: 'right', cell: (r) => r.transactions },
  { id: 'rev', header: 'Pendapatan (Rp)', align: 'right', cell: (r) => <span className="whitespace-nowrap">{money(r.revenue)}</span> },
  { id: 'sent', header: 'Struk terkirim', align: 'right', cell: (r) => r.receiptsSent },
  { id: 'rated', header: 'Penilaian', align: 'right', cell: (r) => r.ratingsReceived },
  { id: 'rate', header: 'Respons %', align: 'right', cell: (r) => percentText(r.responseRate) },
  { id: 'avg', header: 'Rata-rata ★', align: 'right', cell: (r) => avgText(r.avgStars) },
  { id: 'dist', header: 'Sebaran', cell: (r) => <StarBar counts={r.starCounts} /> },
  {
    id: 'flag',
    header: 'Ditandai',
    align: 'right',
    cell: (r) => r.flaggedCount > 0
      ? <span title={FLAG_HINT}><Badge tone="warning">{r.flaggedCount}</Badge></span>
      : <span className="text-ink-500">0</span>,
  },
]

interface ViewProps {
  report: SalesPerformanceReport | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  onOpen: (row: SalesPerformanceRow) => void
}

/** Summary strip + per-salesperson table (presentational). */
export function SalesPerformanceView({ report, loading, error, onRetry, onOpen }: ViewProps) {
  const t = report?.totals
  const tiles: Array<[string, string]> = [
    ['Transaksi', String(t?.transactions ?? 0)],
    ['Pendapatan', money(t?.revenue ?? 0)],
    ['Struk terkirim', String(t?.receiptsSent ?? 0)],
    ['Penilaian', String(t?.ratingsReceived ?? 0)],
    ['Respons %', percentText(t?.responseRate ?? 0)],
    ['Rata-rata ★', avgText(t?.avgStars)],
  ]
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6" aria-label="Ringkasan">
        {tiles.map(([label, value]) => (
          <Card key={label} className="p-4">
            <p className="text-xl font-black text-gray-900">{value}</p>
            <p className="text-xs text-ink-500">{label}</p>
          </Card>
        ))}
      </div>
      <DataTable
        caption="Performa sales"
        columns={COLUMNS}
        rows={report?.data ?? []}
        rowKey={(r) => r.salesmanId ?? 'none'}
        onRowClick={onOpen}
        loading={loading && !report}
        error={error ? `Gagal memuat data. Data sebelumnya mungkin ditampilkan. ${error}` : null}
        onRetry={onRetry}
        empty={<EmptyState icon={<Star />} title="Belum ada penilaian bulan ini." />}
      />
    </>
  )
}

interface RatingsListProps {
  rows: readonly SalesRating[]
  loading: boolean
  error: string | null
}

/** The drill-down's rating cards (presentational). */
export function RatingsList({ rows, loading, error }: RatingsListProps) {
  if (error) return <p role="alert" className="text-sm font-bold text-danger">Gagal memuat penilaian. {error}</p>
  if (loading && rows.length === 0) return <p className="text-sm text-ink-700">Memuat penilaian…</p>
  if (rows.length === 0) return <EmptyState icon={<Star />} title="Belum ada penilaian pada rentang ini." />
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id} className="rounded-2xl border border-paper-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Stars n={r.stars} />
            <span className="font-mono text-sm font-bold">{r.orderNumber}</span>
            <span className="text-xs text-ink-700">{r.outletName ?? ''} · {r.businessDate}</span>
          </div>
          {r.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.tags.map((tag) => <Badge key={tag} tone="neutral">{ratingTagLabel(tag)}</Badge>)}
            </div>
          )}
          {r.comment && <p className="mt-2 text-sm text-ink-900">{r.comment}</p>}
          {ratingFlags(r).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ratingFlags(r).map((f) => <span key={f} title={FLAG_HINT}><Badge tone="warning">{f}</Badge></span>)}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

interface DrillProps {
  row: SalesPerformanceRow
  dateFrom: string
  dateTo: string
  outletId: string
  onClose: () => void
}

function RatingsDrillDown({ row, dateFrom, dateTo, outletId, onClose }: DrillProps) {
  const [page, setPage] = useState(1)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const salesmanId = ratingsSalesmanFilter(row)
  const q = usePolledQuery(
    () => api.listSalesRatings(ratingsParams({ dateFrom, dateTo, outletId, salesmanId, flaggedOnly, page })),
    [dateFrom, dateTo, outletId, salesmanId, flaggedOnly, page],
    60000,
  )
  return (
    <SlideOver
      open
      onClose={onClose}
      dirty={false}
      width="md"
      title={`Penilaian: ${salesmanLabel(row)}`}
      subtitle={`${dateFrom} s/d ${dateTo}`}
    >
      <div className="space-y-4">
        <label className="flex h-10 w-fit items-center gap-2 rounded-xl bg-paper-1 px-3 text-[13px] font-bold text-ink-900">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => { setFlaggedOnly(e.target.checked); setPage(1) }} />
          Hanya yang ditandai
        </label>
        <RatingsList rows={q.data?.data ?? []} loading={q.loading} error={q.error} />
        <ReportPager page={page} total={q.data?.meta?.total ?? 0} limit={RATINGS_PAGE_SIZE} onChange={setPage} />
      </div>
    </SlideOver>
  )
}

interface TabProps {
  dateFrom: string
  dateTo: string
  outletId: string
  onPickMonth: (from: string, to: string) => void
}

/** Laporan > Performa Sales (remounted by the hub on date/outlet change): per-salesperson sales, receipts sent and customer ratings. */
export function SalesPerformanceTab({ dateFrom, dateTo, outletId, onPickMonth }: TabProps) {
  const [open, setOpen] = useState<SalesPerformanceRow | null>(null)
  const rq = usePolledQuery<SalesPerformanceReport>(
    () => api.getSalesPerformance({ dateFrom, dateTo, outletId: outletId || undefined }),
    [dateFrom, dateTo, outletId],
  )
  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Input
          type="month"
          label="Bulan"
          value={monthOfDay(dateFrom)}
          onChange={(e) => {
            const r = monthRange(e.target.value)
            if (r) onPickMonth(r.from, r.to)
          }}
          className="w-auto"
        />
      </Card>
      <SalesPerformanceView report={rq.data} loading={rq.loading} error={rq.error} onRetry={() => void rq.refetch()} onOpen={setOpen} />
      {open && <RatingsDrillDown row={open} dateFrom={dateFrom} dateTo={dateTo} outletId={outletId} onClose={() => setOpen(null)} />}
    </div>
  )
}
