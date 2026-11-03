import { useEffect, useState } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { RefundReport } from '@mandalika/api'
import { Download, RotateCcw } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { BRAND } from '../../lib/brand'
import { buildExportName, exportToCSV } from '../../lib/csvUtils'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { Select } from '../../ui/Field'
import { useListState, type ListSchema } from '../../lib/router/useListState'
import { PAGING_SCHEMA, enumOf, pageOf, pageSizeOf, pageToClamp } from './reportFilters'
import {
  REFUND_FLAG_OPTIONS, claimedIfDifferent, flagLabel, flagTone, formatRefundTime, itemSummary,
  refundCsvRows, scopeLabel, type RefundFlagFilter,
} from './refundReport'

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

const HEADERS =['Waktu refund', 'No. struk', 'Outlet', 'Kasir / Oleh', 'Cakupan', 'Barang & qty', 'Jumlah', 'Diklaim tablet', 'Alasan']

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
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const filters = { dateFrom, dateTo, outletId: outletId || undefined, flag: flag || undefined }
  const rq = usePolledQuery<RefundReport>(
    () => api.listRefundReport({ ...filters, page, limit: pageSize }),
    [dateFrom, dateTo, outletId, flag, page, pageSize],
  )

  const rows = rq.data?.data ?? []
  const summary = rq.data?.summary
  const total = rq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (rq.loading || rq.error || !rq.data) return
    const target = pageToClamp(page, total, pageSize)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [rq.loading, rq.error, rq.data, page, total, pageSize, setState])

  const runExport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const all = await fetchAllPages((p, limit) => api.listRefundReport({ ...filters, page: p, limit }))
      exportToCSV(refundCsvRows(all), buildExportName('laporan-refund', [dateFrom, dateTo, flag]))
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Gagal mengekspor data lengkap.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-5">
      {rq.error && (
        <p role="alert" className="text-sm text-red-600">Gagal memuat data. Data sebelumnya mungkin ditampilkan. {rq.error}</p>
      )}
      {exportError && <p role="alert" className="text-sm text-red-600">{exportError}</p>}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select label="Peringatan" value={flag} onChange={(e) => setState({ tanda: e.target.value, hal: 1 })} className="w-auto">
          {REFUND_FLAG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <Button
          variant="secondary"
          onClick={() => void runExport()}
          disabled={exporting || !!rq.error || total === 0}
          icon={<Download className="w-4 h-4" />}
        >
          {exporting ? 'Menyiapkan…' : 'Unduh CSV refund'}
        </Button>
      </div>

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

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<RotateCcw />} title={rq.loading ? 'Memuat data…' : 'Belum ada refund pada rentang ini'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {HEADERS.map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => {
                  const claimed = claimedIfDifferent(r)
                  return (
                    <tr key={r.id} className="hover:bg-gray-50 align-top">
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{formatRefundTime(r.refundedAt)}</td>
                      <td className="px-4 py-3 text-sm font-mono font-bold text-gray-900 whitespace-nowrap">
                        {r.orderNumber}
                        <span className="block text-xs font-sans font-normal text-gray-400">Refund ke-{r.seq}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.outletName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {r.cashierName}
                        <span className="block text-xs text-gray-400">Oleh {r.refundedByName || '—'}</span>
                      </td>
                      <td className="px-4 py-3"><Badge tone={r.scope === 'partial' ? 'gold' : 'neutral'}>{scopeLabel(r.scope)}</Badge></td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs">{itemSummary(r.items) || '—'}</td>
                      <td className="px-4 py-3 text-sm font-black text-gold-600 whitespace-nowrap">{BRAND.currency.format(r.amount)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                        {claimed === null ? '—' : (
                          <>
                            {BRAND.currency.format(claimed)}
                            <Badge tone={flagTone(r.amountWarning)} className="ml-2">{flagLabel(r.amountWarning) || 'Beda'}</Badge>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs">{r.reason}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          onChange={(p) => setState({ hal: p })}
          pageSize={pageSize}
          onPageSizeChange={(n) => setState({ per: n, hal: 1 })}
        />
      )}
    </div>
  )
}
