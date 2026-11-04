import { useEffect } from 'react'
import { Tag } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge } from '../../ui/StatusBadge'
import { DISCOUNT_CODE_STATUS } from '../../lib/labels/discountCode'
import { useListState } from '../../lib/router/useListState'
import { PAGE_ONLY_SCHEMA, isAnswerFor, pageOf, pageToClamp, totalPagesOf } from './reportFilters'
import { ReportPager } from './ReportPager'
import type { components } from '@mandalika/api'

type Report = components['schemas']['DiscountCodeReport']

const LIMIT = 50

/** A code row with its position: a code can repeat when the report splits it by promotion. */
type CodeRow = Report['data'][number] & { rowIndex: number }

const CODE_COLUMNS: Column<CodeRow>[] = [
  { id: 'kode', header: 'Kode', cell: (c) => <span className="font-mono font-bold">{c.code}</span> },
  { id: 'promosi', header: 'Promosi', cell: (c) => c.promotionName ?? '—' },
  { id: 'penukaran', header: 'Penukaran', align: 'right', cell: (c) => c.redemptions ?? 0 },
  { id: 'nilai', header: 'Nilai', align: 'right', cell: (c) => <span className="font-black">{BRAND.currency.format(c.valueGiven ?? 0)}</span> },
  { id: 'sisa', header: 'Sisa kuota', align: 'right', cell: (c) => c.remaining ?? '∞' },
  { id: 'status', header: 'Status', cell: (c) => <StatusBadge map={DISCOUNT_CODE_STATUS} value={c.status} /> },
]

interface DiscountCodeReportTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Backoffice "Kode Diskon" report tab: redemption summary + detail table for
 * discount codes, scoped by the hub's date range (outlet scope rides the
 * request header, not a query param — `outletId` here is a query dep only,
 * so switching outlets still refetches). Reuses `listDiscountCodeReport`
 * (SP-Code-2 grant-reporting-view sibling, Task 4). */
export function DiscountCodeReportTab({ dateFrom, dateTo, outletId }: DiscountCodeReportTabProps) {
  // The page is URL state (#/laporan/kode-diskon?hal=2). The hub sets hal back to 1 when it narrows the set
  // (date range / outlet), else the user can be stranded on a now-empty page while summary cards still total.
  const [state, setState] = useListState(PAGE_ONLY_SCHEMA)
  const page = pageOf(state.hal)

  const rq = usePolledQuery<Report>(
    () => api.listDiscountCodeReport({ dateFrom, dateTo, page, limit: LIMIT }),
    [dateFrom, dateTo, outletId, page],
  )

  const report = rq.data
  const rows: CodeRow[] = (report?.data ?? []).map((c, rowIndex) => ({ ...c, rowIndex }))
  const summary = report?.summary
  const meta = report?.meta

  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !isAnswerFor(meta, page)) return
    if (!meta) return
    const target = pageToClamp(page, meta.total, meta.limit || LIMIT)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, meta, page, setState])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.totalRedemptions ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Penukaran</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{BRAND.currency.format(summary?.totalValue ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Nilai Diskon</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.distinctCodes ?? 0)}</p>
          <p className="text-xs text-gray-400">Jumlah Kode</p>
        </Card>
      </div>

      <DataTable
        caption="Penukaran kode diskon"
        columns={CODE_COLUMNS}
        rows={rows}
        rowKey={(c) => `${c.code ?? 'code'}-${c.rowIndex}`}
        loading={rq.loading && !rq.data}
        error={rq.error ? `Gagal memuat laporan kode diskon. ${rq.error}` : null}
        onRetry={() => void rq.refetch()}
        empty={<EmptyState icon={<Tag />} title="Belum ada penukaran kode pada rentang ini" />}
        footer={meta && totalPagesOf(meta.total, meta.limit || LIMIT) > 1 ? <ReportPager page={page} total={meta.total} limit={meta.limit || LIMIT} onChange={(p) => setState({ hal: p })} /> : undefined}
      />
    </div>
  )
}
