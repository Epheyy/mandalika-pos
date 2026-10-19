import { fetchAllPages } from '@mandalika/api'
import type { ListShiftsParams, Outlet, Shift } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Download, ShoppingBag } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { exportToCSV, buildExportName } from '../../lib/csvUtils'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { CASH_REFUNDS_PAID_HEADER, cashRefundsPaidCell } from '../refundDisplay'

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
        'Total Refund': s.totalRefunds || 0,
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
        <p role="alert" className="text-sm text-red-600">
          Gagal memuat data lengkap. Data sebelumnya mungkin ditampilkan; ekspor dinonaktifkan. {sq.error}
        </p>
      )}
      {sq.loading && <p role="status">Memuat data lengkap…</p>}
      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={exportSh}
          disabled={sq.loading || !!sq.error || !sq.data}
          icon={<Download className="w-4 h-4" />}
        >
          Export CSV
        </Button>
      </div>
      {sq.data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(shifts.reduce((s, sh) => s + sh.totalSales, 0)) },
              { label: 'Total Transaksi', value: String(shifts.reduce((s, sh) => s + sh.totalOrders, 0)) },
              { label: 'Total Refund', value: BRAND.currency.format(shifts.reduce((s, sh) => s + (sh.totalRefunds || 0), 0)) },
              { label: 'Jumlah Shift', value: String(shifts.length) },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <p className="text-xl font-black text-gray-900">{c.value}</p>
                <p className="text-xs text-gray-400">{c.label}</p>
              </Card>
            ))}
          </div>
          <Card className="overflow-hidden">
            {shifts.length === 0 ? (
              <EmptyState icon={<ShoppingBag />} title="Tidak ada shift" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Kasir', 'Outlet', 'Dibuka', 'Ditutup', 'Transaksi', 'Refund', CASH_REFUNDS_PAID_HEADER, 'Penjualan', 'Tunai', 'QRIS', 'Transfer', 'Kartu'].map((h) => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {shifts.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-bold text-gray-900 text-sm">{s.cashierName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{outletName(s.outletId)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.openedAt ? format(parseISO(s.openedAt), 'dd MMM HH:mm', { locale: idLocale }) : '-'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.closedAt ? format(parseISO(s.closedAt), 'dd MMM HH:mm', { locale: idLocale }) : <span className="text-green-600 font-bold">Buka</span>}</td>
                        <td className="px-4 py-3 text-sm font-bold text-gray-900">{s.totalOrders}</td>
                        <td className="px-4 py-3 text-sm font-bold text-red-600">{BRAND.currency.format(s.totalRefunds || 0)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{cashRefundsPaidCell(s, (n) => BRAND.currency.format(n))}</td>
                        <td className="px-4 py-3 text-sm font-black text-gold-600">{BRAND.currency.format(s.totalSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.cashSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.qrisSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.transferSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.cardSales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  )
}
