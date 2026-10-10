import { useMemo, useState } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { AppSettings, Order, Shift, Outlet } from '@mandalika/api'
import {
  format,
  parseISO,
  isWithinInterval,
  startOfDay,
  endOfDay,
} from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Download, ShoppingBag, TrendingUp, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { exportToCSV, buildExportName } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'
import { paymentFilterOptions } from '../lib/paymentOptions'
import { OrdersPanel } from './Orders'
import { PromoGrantsTab } from './reports/PromoGrantsTab'
import { DiscountCodeReportTab } from './reports/DiscountCodeReportTab'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Field'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'

type ReportTab = 'orders' | 'export' | 'shifts' | 'grants' | 'codeReport'

const statusBadge = (st: string) =>
  st === 'completed' ? (
    <Badge tone="success">Selesai</Badge>
  ) : st === 'refunded' ? (
    <Badge tone="danger">Refund</Badge>
  ) : (
    <Badge tone="neutral">{st}</Badge>
  )

export default function Reports() {
  const { user } = useAuth()
  const { outletId } = useOutlet()

  const isAdmin = user?.role === 'admin'
  const perms = user?.permissions ?? []
  const canViewTransactions = isAdmin || perms.includes('view_transactions')
  const canViewReports = isAdmin || perms.includes('view_reports')

  const visibleTabs = useMemo(() => {
    const t: { id: ReportTab; label: string }[] = []
    if (canViewTransactions) t.push({ id: 'orders', label: 'Transaksi' })
    if (canViewReports) t.push({ id: 'export', label: 'Ekspor' })
    if (canViewReports) t.push({ id: 'shifts', label: 'Shift' })
    if (canViewReports) t.push({ id: 'grants', label: 'Hadiah Promo' })
    if (canViewReports) t.push({ id: 'codeReport', label: 'Kode Diskon' })
    return t
  }, [canViewTransactions, canViewReports])

  const defaultTab: ReportTab = canViewTransactions ? 'orders' : 'export'
  const [tab, setTab] = useState<ReportTab>(defaultTab)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Local calendar date: the range below is built with local startOfDay/endOfDay, so a
  // UTC date (toISOString) would default to yesterday between 00:00–07:00 WIB.
  const [dateFrom, setDateFrom] = useState(() => format(new Date(), 'yyyy-MM-dd'))
  const [dateTo, setDateTo] = useState(() => format(new Date(), 'yyyy-MM-dd'))
  const [fStatus, setFStatus] = useState('')
  const [fPay, setFPay] = useState('')

  const oq = usePolledQuery<Order[]>(() => fetchAllPages((page, limit) => api.listOrders({ page, limit })), [outletId])
  const sq = usePolledQuery<Shift[]>(() => fetchAllPages((page, limit) => api.listShifts({ page, limit })), [outletId])
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const orders = oq.data ?? []
  const aq = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 60000)
  const payOptions = paymentFilterOptions(aq.data?.paymentMethods, orders)
  const shifts = sq.data ?? []
  const outlets = ouq.data ?? []

  const inRange = (s: string) => {
    try {
      return isWithinInterval(parseISO(s), {
        start: startOfDay(parseISO(dateFrom)),
        end: endOfDay(parseISO(dateTo)),
      })
    } catch {
      return false
    }
  }

  const fOrders = orders.filter(
    (o) => inRange(o.createdAt) && (!fStatus || o.status === fStatus) && (!fPay || o.paymentMethod === fPay),
  )
  const fShifts = shifts.filter((s) => inRange(s.openedAt))
  const completed = fOrders.filter((o) => o.status === 'completed')
  const refunded = fOrders.filter((o) => o.status === 'refunded')
  const revenue = completed.reduce((s, o) => s + o.total, 0)
  const refunds = refunded.reduce((s, o) => s + o.total, 0)
  const byPay = completed.reduce<Record<string, number>>((acc, o) => {
    acc[o.paymentMethod] = (acc[o.paymentMethod] || 0) + o.total
    return acc
  }, {})
  const outletName = (oid: string) => outlets.find((o) => o.id === oid)?.name || oid

  const exportTx = () =>
    !oq.loading && !oq.error && oq.data && exportToCSV(
      fOrders.map((o) => ({
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
        fStatus || undefined,
        fPay || undefined,
        `dari-${dateFrom}`,
        `sd-${dateTo}`,
      ]),
    )

  const exportSh = () =>
    !sq.loading && !sq.error && sq.data && exportToCSV(
      fShifts.map((s) => ({
        Kasir: s.cashierName,
        Outlet: outletName(s.outletId),
        Dibuka: s.openedAt ? format(parseISO(s.openedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
        Ditutup: s.closedAt ? format(parseISO(s.closedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
        Status: s.status,
        'Kas Awal': s.startingCash,
        'Kas Akhir': s.closingCash || 0,
        'Total Penjualan': s.totalSales,
        'Total Refund': s.totalRefunds || 0,
        'Jumlah Transaksi': s.totalOrders,
        Tunai: s.cashSales,
        Kartu: s.cardSales,
        Transfer: s.transferSales,
        QRIS: s.qrisSales,
      })),
      buildExportName('laporan-shift', [
        outletId ? outletName(outletId) : 'semua-outlet',
        `dari-${dateFrom}`,
        `sd-${dateTo}`,
      ]),
    )

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Laporan"
        subtitle="Ekspor data untuk analisis lebih lanjut"
        actions={
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={visibleTabs}
          />
        }
      />

      {((tab === 'export' && oq.error) || (tab === 'shifts' && sq.error)) && (
        <p role="alert" className="text-sm text-red-600">
          Gagal memuat data lengkap. Data sebelumnya mungkin ditampilkan; ekspor dinonaktifkan. {tab === 'export' ? oq.error : sq.error}
        </p>
      )}
      {((tab === 'export' && oq.loading) || (tab === 'shifts' && sq.loading)) && <p role="status">Memuat data lengkap…</p>}
      {tab === 'orders' && <OrdersPanel />}

      {tab !== 'orders' && (
      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <Input
          type="date"
          label="Dari"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-auto"
        />
        <Input
          type="date"
          label="Sampai"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-auto"
        />
        {tab === 'export' && (
          <>
            <Select
              label="Status"
              value={fStatus}
              onChange={(e) => setFStatus(e.target.value)}
              className="w-auto"
            >
              <option value="">Semua Status</option>
              <option value="completed">Selesai</option>
              <option value="refunded">Refund</option>
            </Select>
            <Select
              label="Pembayaran"
              value={fPay}
              onChange={(e) => setFPay(e.target.value)}
              className="w-auto"
            >
              <option value="">Semua</option>
              {payOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </>
        )}
        {tab !== 'grants' && tab !== 'codeReport' && (
          <Button
            variant="secondary"
            onClick={tab === 'export' ? exportTx : exportSh}
            disabled={tab === 'export' ? oq.loading || !!oq.error || !oq.data : sq.loading || !!sq.error || !sq.data}
            icon={<Download className="w-4 h-4" />}
          >
            Export CSV
          </Button>
        )}
      </Card>
      )}

      {tab === 'grants' && <PromoGrantsTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} />}

      {tab === 'codeReport' && <DiscountCodeReportTab dateFrom={dateFrom} dateTo={dateTo} outletId={outletId ?? ''} />}

      {tab === 'export' && oq.data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(revenue), icon: <TrendingUp className="w-5 h-5" /> },
              { label: 'Jumlah Transaksi', value: String(completed.length), icon: <ShoppingBag className="w-5 h-5" /> },
              { label: 'Total Refund', value: BRAND.currency.format(refunds), icon: <RotateCcw className="w-5 h-5" /> },
              { label: 'Transaksi Direfund', value: String(refunded.length), icon: <RotateCcw className="w-5 h-5" /> },
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

          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-sm font-bold text-gray-500">{fOrders.length} transaksi</p>
            </div>
            {fOrders.length === 0 ? (
              <EmptyState icon={<ShoppingBag />} title="Tidak ada transaksi" />
            ) : (
              <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
                {fOrders.map((o) => (
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
          </Card>
        </>
      )}

      {tab === 'shifts' && sq.data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(fShifts.reduce((s, sh) => s + sh.totalSales, 0)) },
              { label: 'Total Transaksi', value: String(fShifts.reduce((s, sh) => s + sh.totalOrders, 0)) },
              { label: 'Total Refund', value: BRAND.currency.format(fShifts.reduce((s, sh) => s + (sh.totalRefunds || 0), 0)) },
              { label: 'Jumlah Shift', value: String(fShifts.length) },
            ].map((c) => (
              <Card key={c.label} className="p-4">
                <p className="text-xl font-black text-gray-900">{c.value}</p>
                <p className="text-xs text-gray-400">{c.label}</p>
              </Card>
            ))}
          </div>
          <Card className="overflow-hidden">
            {fShifts.length === 0 ? (
              <EmptyState icon={<ShoppingBag />} title="Tidak ada shift" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Kasir', 'Outlet', 'Dibuka', 'Ditutup', 'Transaksi', 'Refund', 'Penjualan', 'Tunai', 'QRIS', 'Transfer', 'Kartu'].map((h) => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {fShifts.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-bold text-gray-900 text-sm">{s.cashierName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{outletName(s.outletId)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.openedAt ? format(parseISO(s.openedAt), 'dd MMM HH:mm', { locale: idLocale }) : '-'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.closedAt ? format(parseISO(s.closedAt), 'dd MMM HH:mm', { locale: idLocale }) : <span className="text-green-600 font-bold">Buka</span>}</td>
                        <td className="px-4 py-3 text-sm font-bold text-gray-900">{s.totalOrders}</td>
                        <td className="px-4 py-3 text-sm font-bold text-red-600">{BRAND.currency.format(s.totalRefunds || 0)}</td>
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
    </div>
  )
}
