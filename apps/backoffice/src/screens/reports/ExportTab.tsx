import { useEffect, useState } from 'react'
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
import { orderIconClasses, orderStatusLabel, orderStatusTone } from '../../lib/orderStatus'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { orderFilterParams, type OrderFilters } from './orderQuery'
import { breakdownRows, hasRefundBasis, isNegative, moneyOrDash, refundCsvFields, sharePercent } from './exportSummary'
import { refundCsvRows } from './refundReport'
import { methodLabel, orderPaymentCsv, refundPayoutCsv } from '../../lib/splitPayment'
import { useOrderReport } from './useOrderReport'
import { useListState } from '../../lib/router/useListState'
import { PAGING_SCHEMA, isAnswerFor, pageOf, pageSizeOf, pageToClamp } from './reportFilters'

const statusBadge = (st: string) => <Badge tone={orderStatusTone(st)}>{orderStatusLabel(st)}</Badge>

interface ExportTabProps {
  filters: OrderFilters
  outletId: string | null | undefined
  outlets: Outlet[]
  /** Configured methods, to label payment lines; absent = raw ids. */
  paymentMethods?: ReadonlyArray<{ id: string; label: string }>
}

/** Laporan > Ekspor: server totals + one server-paged page of orders; the CSV pages
 * the whole filtered set on click instead of keeping every order in the browser. */
export function ExportTab({ filters, outletId, outlets, paymentMethods }: ExportTabProps) {
  // Paging is URL state; the hub remounts this tab on a filter change and sets hal back to 1 in the same patch.
  const [paging, setPaging] = useListState(PAGING_SCHEMA)
  const page = pageOf(paging.hal)
  const pageSize = pageSizeOf(paging.per)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const { summary: sq, list: lq } = useOrderReport(filters, page, pageSize, outletId)

  const summary = sq.data
  const orders = lq.data?.data ?? []
  const total = lq.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // A page past the end (a stale link) moves to the last page.
  useEffect(() => {
    if (lq.loading || lq.error || !lq.data || !isAnswerFor(lq.data.meta, page, pageSize)) return
    const target = pageToClamp(page, total, pageSize)
    if (target !== null) setPaging({ hal: target }, { replace: true })
  }, [lq.loading, lq.error, lq.data, page, total, pageSize, setPaging])
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid

  const csvRows = (all: Order[]) =>
    all.map((o) => {
      const rf = refundCsvFields(o)
      return {
      'No. Order': o.orderNumber,
      Tanggal: format(parseISO(o.createdAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }),
      'Hari Bisnis': o.businessDate ?? '',
      'Waktu Refund': rf.refundedAt ? format(parseISO(rf.refundedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '',
      'Hari Refund': rf.refundBusinessDate ?? '',
      Kasir: o.cashierName,
      Salesman: o.salesmanName || '-',
      Pelanggan: o.customerName || '-',
      Item: o.items.map((i) => `${i.productName} ${i.variantSize} x${i.quantity}`).join('; '),
      Subtotal: o.subtotal,
      Diskon: o.discountAmount,
      Pajak: o.taxAmount,
      Total: o.total,
      'Jumlah Refund': rf.amount,
      // A split sale lists its lines ("QRIS 751.000; Tunai 500.000"); 'Metode Refund' is where the
      // money went back (the refund's own method), which can differ from how the sale was paid.
      'Metode Bayar': orderPaymentCsv(o, paymentMethods),
      'Metode Refund': refundPayoutCsv(o, paymentMethods),
      Status: o.status,
      Catatan: o.notes || '',
      'Alasan Refund': rf.reason,
      Outlet: outletName(o.outletId),
      }
    })

  const exportName = (prefix: string) =>
    buildExportName(prefix, [
      outletId ? outletName(outletId) : 'semua-outlet',
      filters.status || undefined,
      filters.payment || undefined,
      filters.dateFrom ? `dari-${filters.dateFrom}` : 'semua-tanggal',
      filters.dateTo ? `sd-${filters.dateTo}` : undefined,
    ])

  /** Pages the whole filtered set and downloads it: orders by sale day, or one row per refund
   * (same builder as Laporan > Refund) by refund day. */
  const runExport = async (basis: 'sale' | 'refund') => {
    setExporting(true)
    setExportError(null)
    try {
      if (basis === 'refund') {
        const all = await fetchAllPages((p, limit) =>
          api.listRefundReport({ dateFrom: filters.dateFrom, dateTo: filters.dateTo, outletId: outletId || undefined, page: p, limit }))
        exportToCSV(refundCsvRows(all), exportName('laporan-refund'))
      } else {
        const all: Order[] = await fetchAllPages((p, limit) => api.listOrders({ ...orderFilterParams(filters), page: p, limit }))
        exportToCSV(csvRows(all), exportName('laporan-transaksi'))
      }
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Gagal mengekspor data lengkap.')
    } finally {
      setExporting(false)
    }
  }

  const error = sq.error || lq.error
  const rows = summary ? breakdownRows(summary) : []

  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-danger">
          Gagal memuat data. Data sebelumnya mungkin ditampilkan. {error}
        </p>
      )}
      {exportError && <p role="alert" className="text-sm text-danger">{exportError}</p>}
      {(sq.loading || lq.loading) && <p role="status">Memuat data…</p>}
      <div className="flex justify-end items-center gap-2">
        <span className="text-xs text-gray-400">CSV refund memakai rentang tanggal dan outlet saja.</span>
        <Button
          variant="secondary"
          onClick={() => void runExport('refund')}
          disabled={exporting || sq.loading || lq.loading}
          icon={<Download className="w-4 h-4" />}
        >
          {exporting ? 'Menyiapkan…' : 'Unduh CSV refund'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void runExport('sale')}
          disabled={exporting || lq.loading || !!lq.error || total === 0}
          icon={<Download className="w-4 h-4" />}
        >
          {exporting ? 'Menyiapkan…' : 'Unduh CSV'}
        </Button>
      </div>

      {summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Penjualan Kotor', value: moneyOrDash(summary.grossSales, BRAND.currency.format), sub: summary.grossOrders === undefined ? undefined : `${summary.grossOrders} penjualan`, icon: <TrendingUp className="w-5 h-5" /> },
              { label: 'Refund (hari refund)', value: hasRefundBasis(summary) ? BRAND.currency.format(summary.totalRefunds) : '–', sub: hasRefundBasis(summary) ? `${summary.refundedOrders} refund` : undefined, icon: <RotateCcw className="w-5 h-5" /> },
              { label: 'Penjualan Bersih', value: moneyOrDash(summary.netSales, BRAND.currency.format), negative: isNegative(summary.netSales), icon: <TrendingUp className="w-5 h-5" /> },
              { label: 'Jumlah Transaksi', value: String(summary.totalOrders), icon: <ShoppingBag className="w-5 h-5" /> },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-2 bg-gold-50 text-gold-600">
                  {c.icon}
                </div>
                <p className={`text-xl font-black ${c.negative ? 'text-danger' : 'text-gray-900'}`}>{c.value}</p>
                <p className="text-xs text-gray-400">{c.label}</p>
                {c.sub && <p className="text-xs text-gray-400">{c.sub}</p>}
              </Card>
            ))}
          </div>
          <p className="text-xs text-gray-400">
            Refund dihitung pada hari refund, bukan hari penjualan. Daftar di bawah memakai hari penjualan.
          </p>

          {rows.length > 0 && (
            <Card className="p-5">
              <h3 className="font-black text-gray-900 mb-3">Breakdown Pembayaran</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {rows.map((r) => (
                  <div key={r.method} className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs font-bold text-gray-500 capitalize mb-1">{methodLabel(r.method, paymentMethods)}</p>
                    <p className="text-xs text-gray-500">Kotor <span className="font-black text-gray-900 text-sm">{BRAND.currency.format(r.gross)}</span></p>
                    <p className="text-xs text-gray-500">Refund <span className="font-black text-danger text-sm">{BRAND.currency.format(r.refunds)}</span></p>
                    <p className="text-xs text-gray-500">Bersih <span className={`font-black text-sm ${r.net < 0 ? 'text-danger' : 'text-gray-900'}`}>{BRAND.currency.format(r.net)}</span></p>
                    <p className="text-xs text-gray-400">{sharePercent(r.gross, summary.grossSales ?? 0)}%</p>
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
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${orderIconClasses(o.status).tile}`}>
                    <ShoppingBag className={`w-4 h-4 ${orderIconClasses(o.status).glyph}`} />
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
              onChange={(p) => setPaging({ hal: p })}
              pageSize={pageSize}
              onPageSizeChange={(n) => setPaging({ per: n, hal: 1 })}
            />
          </div>
        )}
      </Card>
    </>
  )
}
