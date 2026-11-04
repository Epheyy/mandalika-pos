import { useEffect } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { RefundReport } from '@mandalika/api'
import { RotateCcw } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { buildExportName, exportToCSV } from '../../lib/csvUtils'
import { Badge } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { Pagination } from '../../ui/Pagination'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGING_SCHEMA, enumOf, isAnswerFor, pageOf, pageSizeOf, pageToClamp, totalPagesOf } from './reportFilters'
import {
  REFUND_FLAG_OPTIONS, claimedIfDifferent, flagLabel, flagTone, formatRefundTime, itemSummary,
  refundCsvRows, scopeLabel, type RefundFlagFilter,
} from './refundReport'

type RefundRow = RefundReport['data'][number]

interface RefundListState {
  tanda: string
  hal: number
  per: number
  [key: string]: string | number
}

const REFUND_SCHEMA: ListSchema<RefundListState> = {
  tanda: { key: 'tanda', default: '' },
  hal: PAGING_SCHEMA.hal,
  per: PAGING_SCHEMA.per,
}

const REFUND_FLAGS = REFUND_FLAG_OPTIONS.map((o) => o.value)

const REFUND_COLUMNS: Column<RefundRow>[] = [
  { id: 'waktu', header: 'Waktu refund', cell: (r) => <span className="whitespace-nowrap">{formatRefundTime(r.refundedAt)}</span> },
  {
    id: 'struk',
    header: 'No. struk',
    cell: (r) => (
      <span className="whitespace-nowrap font-mono font-bold">
        {r.orderNumber}
        <span className="block font-sans text-xs font-normal text-ink-700">Refund ke-{r.seq}</span>
      </span>
    ),
  },
  { id: 'outlet', header: 'Outlet', cell: (r) => r.outletName },
  {
    id: 'kasir',
    header: 'Kasir / Oleh',
    cell: (r) => (
      <>
        {r.cashierName}
        <span className="block text-xs text-ink-700">Oleh {r.refundedByName || '—'}</span>
      </>
    ),
  },
  { id: 'cakupan', header: 'Cakupan', cell: (r) => <Badge tone={r.scope === 'partial' ? 'gold' : 'neutral'}>{scopeLabel(r.scope)}</Badge> },
  { id: 'barang', header: 'Barang & qty', cell: (r) => <span className="block max-w-xs">{itemSummary(r.items) || '—'}</span> },
  { id: 'jumlah', header: 'Jumlah', align: 'right', cell: (r) => <span className="whitespace-nowrap font-black">{BRAND.currency.format(r.amount)}</span> },
  {
    id: 'diklaim',
    header: 'Diklaim tablet',
    align: 'right',
    cell: (r) => {
      const claimed = claimedIfDifferent(r)
      if (claimed === null) return '—'
      return (
        <span className="whitespace-nowrap">
          {BRAND.currency.format(claimed)}
          <Badge tone={flagTone(r.amountWarning)} className="ml-2">{flagLabel(r.amountWarning) || 'Beda'}</Badge>
        </span>
      )
    },
  },
  { id: 'alasan', header: 'Alasan', cell: (r) => <span className="block max-w-xs">{r.reason}</span> },
]

interface RefundReportTabProps {
  dateFrom: string
  dateTo: string
  outletId: string
}

/** Laporan > Refund (remounted by the hub on date/outlet change, so paging restarts): one row per refund (C4c) over the hub's refund-day range, with the
 * server's amount warnings; the CSV pages the whole filtered set with the same filters. */
export function RefundReportTab({ dateFrom, dateTo, outletId }: RefundReportTabProps) {
  // The warning filter and the page are URL state (#/laporan/refund?tanda=any&hal=2); the hub remounts this tab
  // on a date or outlet change and sets hal back to 1 in the same patch.
  const [state, setState] = useListState(REFUND_SCHEMA)
  const page = pageOf(state.hal)
  const pageSize = pageSizeOf(state.per)
  const flag = enumOf<RefundFlagFilter>(state.tanda, REFUND_FLAGS, '')

  const filters = { dateFrom, dateTo, outletId: outletId || undefined, flag: flag || undefined }
  const rq = usePolledQuery<RefundReport>(
    () => api.listRefundReport({ ...filters, page, limit: pageSize }),
    [dateFrom, dateTo, outletId, flag, page, pageSize],
  )

  const rows = rq.data?.data ?? []
  const summary = rq.data?.summary
  const total = rq.data?.meta?.total ?? 0
  const totalPages = totalPagesOf(total, pageSize)

  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !rq.data || !isAnswerFor(rq.data.meta, page, pageSize)) return
    const target = pageToClamp(page, total, pageSize)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, rq.data, page, total, pageSize, setState])

  // A failed export is shown by the ExportButton itself (it keeps the server's message).
  const runExport = async () => {
    const all = await fetchAllPages((p, limit) => api.listRefundReport({ ...filters, page: p, limit }))
    exportToCSV(refundCsvRows(all), buildExportName('laporan-refund', [dateFrom, dateTo, flag]))
  }

  return (
    <div className="space-y-5">
      <FilterBar
        onReset={() => setState({ tanda: '', hal: 1 })}
        activeCount={flag ? 1 : 0}
        actions={
          <ExportButton
            qualifier="refund"
            rowCount={rq.data ? total : null}
            filterSummary={[dateFrom && `dari ${dateFrom}`, dateTo && `sampai ${dateTo}`, flag && `peringatan ${REFUND_FLAG_OPTIONS.find((o) => o.value === flag)?.label ?? flag}`].filter(Boolean) as string[]}
            disabled={!!rq.error}
            onExport={runExport}
          />
        }
      >
        <FilterBar.Select label="Peringatan" value={flag} onChange={(v) => setState({ tanda: v, hal: 1 })} options={REFUND_FLAG_OPTIONS} />
      </FilterBar>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.count ?? 0)}</p>
          <p className="text-xs text-gray-400">Jumlah Refund</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{BRAND.currency.format(summary?.totalAmount ?? 0)}</p>
          <p className="text-xs text-gray-400">Total Refund</p>
        </Card>
        <Card className="p-4">
          <p className="text-xl font-black text-gray-900">{String(summary?.flaggedCount ?? 0)}</p>
          <p className="text-xs text-gray-400">Ada Peringatan</p>
        </Card>
      </div>

      <DataTable
        caption="Daftar refund"
        columns={REFUND_COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        loading={rq.loading && !rq.data}
        error={rq.error ? `Gagal memuat data. Data sebelumnya mungkin ditampilkan. ${rq.error}` : null}
        onRetry={() => void rq.refetch()}
        empty={<EmptyState icon={<RotateCcw />} title="Belum ada refund pada rentang ini" />}
        footer={
          totalPages > 1 ? (
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onChange={(p) => setState({ hal: p })}
              pageSize={pageSize}
              onPageSizeChange={(n) => setState({ per: n, hal: 1 })}
            />
          ) : undefined
        }
      />
    </div>
  )
}
