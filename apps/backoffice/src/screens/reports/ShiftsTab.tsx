import { fetchAllPages } from '@mandalika/api'
import type { ListShiftsParams, Outlet, Shift } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { ShoppingBag } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV, buildExportName } from '../../lib/csvUtils'
import { BRAND } from '../../lib/brand'
import { Card } from '../../ui/Card'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { ExportButton } from '../../ui/ExportButton'
import { FilterBar } from '../../ui/FilterBar'
import { CASH_REFUNDS_PAID_HEADER, cashRefundsPaidCell } from '../refundDisplay'

interface ShiftsTabProps {
  dateFrom: string
  dateTo: string
  outletId: string | null | undefined
  outlets: Outlet[]
}

const money = (n: number) => BRAND.currency.format(n)
const whenShort = (iso: string | null | undefined) => (iso ? format(parseISO(iso), 'dd MMM HH:mm', { locale: idLocale }) : '-')

const REFUND_SHIFT_LABEL = 'Refund penjualan shift'
const REFUND_SHIFT_HINT = 'Mengikuti shift yang membuat penjualan. Tab Unduh data menghitung refund pada hari refund, jadi angkanya bisa berbeda.'

function shiftColumns(outletName: (id: string) => string): Column<Shift>[] {
  return [
    { id: 'kasir', header: 'Kasir', cell: (s) => <span className="font-bold">{s.cashierName}</span> },
    { id: 'outlet', header: 'Outlet', cell: (s) => outletName(s.outletId) },
    { id: 'dibuka', header: 'Dibuka', cell: (s) => <span className="whitespace-nowrap text-xs">{whenShort(s.openedAt)}</span> },
    {
      id: 'ditutup',
      header: 'Ditutup',
      cell: (s) => (s.closedAt ? <span className="whitespace-nowrap text-xs">{whenShort(s.closedAt)}</span> : <span className="text-xs font-bold text-ok">Buka</span>),
    },
    { id: 'transaksi', header: 'Transaksi', align: 'right', cell: (s) => <span className="font-bold">{s.totalOrders}</span> },
    { id: 'refund', header: REFUND_SHIFT_LABEL, align: 'right', cell: (s) => <span className="font-bold text-danger" title={REFUND_SHIFT_HINT}>{money(s.totalRefunds || 0)}</span> },
    { id: 'refund-tunai', header: CASH_REFUNDS_PAID_HEADER, align: 'right', cell: (s) => <span className="text-xs">{cashRefundsPaidCell(s, money)}</span> },
    { id: 'penjualan', header: 'Penjualan', align: 'right', cell: (s) => <span className="font-black">{money(s.totalSales)}</span> },
    { id: 'tunai', header: 'Tunai', align: 'right', cell: (s) => <span className="text-xs">{money(s.cashSales)}</span> },
    { id: 'qris', header: 'QRIS', align: 'right', cell: (s) => <span className="text-xs">{money(s.qrisSales)}</span> },
    { id: 'transfer', header: 'Transfer', align: 'right', cell: (s) => <span className="text-xs">{money(s.transferSales)}</span> },
    { id: 'kartu', header: 'Kartu', align: 'right', cell: (s) => <span className="text-xs">{money(s.cardSales)}</span> },
  ]
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

  const exportSh = () =>
    exportToCSV(
      shifts.map((s) => ({
        Kasir: s.cashierName,
        Outlet: outletName(s.outletId),
        Dibuka: s.openedAt ? format(parseISO(s.openedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
        Ditutup: s.closedAt ? format(parseISO(s.closedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
        Status: s.status,
        'Kas Awal': s.startingCash,
        'Kas Akhir': s.closingCash || 0,
        'Total Penjualan': s.totalSales,
        [REFUND_SHIFT_LABEL]: s.totalRefunds || 0,
        [CASH_REFUNDS_PAID_HEADER]: cashRefundsPaidCell(s),
        'Jumlah Transaksi': s.totalOrders,
        Tunai: s.cashSales,
        Kartu: s.cardSales,
        Transfer: s.transferSales,
        QRIS: s.qrisSales,
      })),
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
              { label: 'Total Penjualan', value: BRAND.currency.format(shifts.reduce((s, sh) => s + sh.totalSales, 0)) },
              { label: 'Total Transaksi', value: String(shifts.reduce((s, sh) => s + sh.totalOrders, 0)) },
              { label: REFUND_SHIFT_LABEL, hint: REFUND_SHIFT_HINT, value: BRAND.currency.format(shifts.reduce((s, sh) => s + (sh.totalRefunds || 0), 0)) },
              { label: 'Jumlah Shift', value: String(shifts.length) },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <p className="text-xl font-black text-gray-900">{c.value}</p>
                <p className="text-xs text-gray-400" title={'hint' in c ? c.hint : undefined}>{c.label}</p>
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
