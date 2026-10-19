import { useState } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { Order, Outlet } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Download, ShoppingBag, TrendingUp, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../../api'
import { exportToCSV, buildExportName } from '../../lib/csvUtils'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { orderFilterParams, type OrderFilters } from './orderQuery'
import { useOrderReport } from './useOrderReport'

const statusBadge = (st: string) =>
  st === 'completed' ? (
    <Badge tone="success">Selesai</Badge>
  ) : st === 'refunded' ? (
    <Badge tone="danger">Refund</Badge>
  ) : (
    <Badge tone="neutral">{st}</Badge>
  )

interface ExportTabProps {
  filters: OrderFilters
  outletId: string | null | undefined
  outlets: Outlet[]
}

/** Laporan > Ekspor: server totals + one server-paged page of orders; the CSV pages
 * the whole filtered set on click instead of keeping every order in the browser. */
export function ExportTab({ filters, outletId, outlets }: ExportTabProps) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const { summary: sq, list: lq } = useOrderReport(filters, page, pageSize, outletId)

  const summary = sq.data
  const orders = lq.data?.data ?? []
  const total = lq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid

  const exportTx = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const params = orderFilterParams(filters)
      const all: Order[] = await fetchAllPages((p, limit) => api.listOrders({ ...params, page: p, limit }))
      exportToCSV(
        all.map((o) => ({
          'No. Order': o.orderNumber,
          Tanggal: format(parseISO(o.createdAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }),
          Kasir: o.cashierName,
          Salesman: o.salesmanName || '-',
          Pelanggan: o.customerName || '-',
          Item: o.items.map((i) => `${i.productName} ${i.variantSize} x${i.quantity}`).join('; '),
          Subtotal: o.subtotal,
          Diskon: o.discountAmount,
          Pajak: o.taxAmount,
          Total: o.total,
          'Metode Bayar': o.paymentMethod,
          Status: o.status,
          Catatan: o.notes || '',
          'Alasan Refund': o.refundReason || '',
          Outlet: outletName(o.outletId),
        })),
        buildExportName('laporan-transaksi', [
          outletId ? outletName(outletId) : 'semua-outlet',
          filters.status || undefined,
          filters.payment || undefined,
          filters.dateFrom ? `dari-${filters.dateFrom}` : 'semua-tanggal',
          filters.dateTo ? `sd-${filters.dateTo}` : undefined,
        ]),
      )
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Gagal mengekspor data lengkap.')
    } finally {
      setExporting(false)
    }
  }

  const error = sq.error || lq.error
  const revenue = summary?.totalSales ?? 0
  const byPay = summary?.byPaymentMethod ?? {}

  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          Gagal memuat data. Data sebelumnya mungkin ditampilkan. {error}
        </p>
      )}
      {exportError && <p role="alert" className="text-sm text-red-600">{exportError}</p>}
      {(sq.loading || lq.loading) && <p role="status">Memuat data…</p>}
      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={() => void exportTx()}
          disabled={exporting || lq.loading || !!lq.error || total === 0}
          icon={<Download className="w-4 h-4" />}
        >
          {exporting ? 'Menyiapkan…' : 'Export CSV'}
        </Button>
      </div>

      {summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(revenue), icon: <TrendingUp className="w-5 h-5" /> },
              { label: 'Jumlah Transaksi', value: String(summary.totalOrders), icon: <ShoppingBag className="w-5 h-5" /> },
              { label: 'Total Refund', value: BRAND.currency.format(summary.totalRefunds), icon: <RotateCcw className="w-5 h-5" /> },
              { label: 'Transaksi Direfund', value: String(summary.refundedOrders), icon: <RotateCcw className="w-5 h-5" /> },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-2 bg-gold-50 text-gold-600">
                  {c.icon}
                </div>
                <p className="text-xl font-black text-gray-900">{c.value}</p>
                <p className="text-xs text-gray-400">{c.label}</p>
              </Card>
            ))}
          </div>

          {Object.keys(byPay).length > 0 && (
            <Card className="p-5">
              <h3 className="font-black text-gray-900 mb-3">Breakdown Pembayaran</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(byPay).map(([m, a]) => (
                  <div key={m} className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs font-bold text-gray-500 capitalize mb-1">{m}</p>
                    <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(a)}</p>
                    <p className="text-xs text-gray-400">{revenue > 0 ? Math.round((a / revenue) * 100) : 0}%</p>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <p className="text-sm font-bold text-gray-500">{total} transaksi</p>
        </div>
        {orders.length === 0 ? (
          <EmptyState icon={<ShoppingBag />} title="Tidak ada transaksi" />
        ) : (
          <div className="divide-y divide-gray-50">
            {orders.map((o) => (
              <div key={o.id}>
                <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer" role="button" tabIndex={0} onClick={() => setExpanded(expanded === o.id ? null : o.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(expanded === o.id ? null : o.id) } }}>
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-gold-50'}`}>
                    <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-gold-600'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · {o.cashierName}
                      {o.customerName && ` · ${o.customerName}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {statusBadge(o.status)}
                    <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                    {expanded === o.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </div>
                </div>
                {expanded === o.id && (
                  <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                    <div className="pt-3 space-y-1">
                      {o.items.map((it) => (
                        <div key={`${it.productId}|${it.variantSize}`} className="flex justify-between text-sm">
                          <span className="text-gray-600">{it.productName} {it.variantSize} ×{it.quantity}</span>
                          <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                        </div>
                      ))}
                      <div className="border-t border-gray-200 pt-2 flex justify-between font-black text-gray-900">
                        <span>Total</span><span>{BRAND.currency.format(o.total)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {total > 0 && (
          <div className="px-5 py-3 border-t border-gray-100">
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1) }}
            />
          </div>
        )}
      </Card>
    </>
  )
}
