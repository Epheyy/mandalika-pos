import { fetchAllPages } from '@mandalika/api'
import type { ListShiftsParams, Outlet, Shift } from '@mandalika/api'
import { ShoppingBag } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV, buildExportName } from '../../lib/csvUtils'
import { BRAND } from '../../lib/brand'
import { Card } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { REFUND_SHIFT_HINT, REFUND_SHIFT_LABEL, shiftColumns, shiftCsvRow, summarizeShifts } from './shiftReport'

interface ShiftsTabProps {
  dateFrom: string
  dateTo: string
  outletId: string | null | undefined
  outlets: Outlet[]
}

/** Laporan > Shift: shifts opened inside the WIB date range (server filtered on
 * opened_at), fetched only while this tab is active. */
export function ShiftsTab({ dateFrom, dateTo, outletId, outlets }: ShiftsTabProps) {
  const sq = usePolledQuery<Shift[]>(() => {
    const params: ListShiftsParams = {}
    if (dateFrom) params.dateFrom = dateFrom
    if (dateTo) params.dateTo = dateTo
    return fetchAllPages((page, limit) => api.listShifts({ ...params, page, limit }))
  }, [outletId, dateFrom, dateTo])
  const shifts = sq.data ?? []
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid
  const columns = shiftColumns(outletName)
  const sum = summarizeShifts(shifts)
  const pendingNote = sum.openCount > 0 ? `+ ${sum.openCount} shift masih buka (belum dihitung)` : null

  const exportSh = () =>
    exportToCSV(
      shifts.map((s) => shiftCsvRow(s, outletName)),
      buildExportName('laporan-shift', [
        outletId ? outletName(outletId) : 'semua-outlet',
        dateFrom ? `dari-${dateFrom}` : 'semua-tanggal',
        dateTo ? `sd-${dateTo}` : undefined,
      ]),
    )

  return (
    <>
      {sq.error && (
        <p role="alert" className="text-sm text-danger">
          Gagal memuat data lengkap. Data sebelumnya mungkin ditampilkan; ekspor dinonaktifkan. {sq.error}
        </p>
      )}
      {sq.loading && <p role="status">Memuat data lengkap…</p>}
      <FilterBar
        actions={
          <ExportButton
            rowCount={sq.data ? shifts.length : null}
            filterSummary={[outletId ? outletName(outletId) : 'Semua outlet', dateFrom ? `dari ${dateFrom}` : 'semua tanggal', dateTo ? `sampai ${dateTo}` : ''].filter(Boolean)}
            disabled={sq.loading || !!sq.error || !sq.data}
            onExport={exportSh}
          />
        }
      >
        <FilterBar.Scope />
      </FilterBar>
      {sq.data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(sum.totalSales), note: pendingNote },
              { label: 'Total Transaksi', value: String(sum.totalOrders), note: pendingNote },
              { label: REFUND_SHIFT_LABEL, hint: REFUND_SHIFT_HINT, value: BRAND.currency.format(sum.totalRefunds), note: pendingNote },
              { label: 'Jumlah Shift', value: String(sum.shiftCount), note: sum.openCount > 0 ? `${sum.openCount} masih buka` : null },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <p className="text-xl font-black text-gray-900">{c.value}</p>
                <p className="text-xs text-ink-500" title={'hint' in c ? c.hint : undefined}>{c.label}</p>
                {c.note && <p className="text-[11px] text-ink-500">{c.note}</p>}
              </Card>
            ))}
          </div>
          <DataTable
            caption="Shift pada rentang tanggal"
            columns={columns}
            rows={shifts}
            rowKey={(s) => s.id}
            empty={<EmptyState icon={<ShoppingBag />} title="Tidak ada shift" />}
          />
        </>
      )}
    </>
  )
}
