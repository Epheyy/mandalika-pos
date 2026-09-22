import { useState, lazy, Suspense } from 'react'
import { fetchAllPages } from '@mandalika/api'
import type { Order, Product, Promotion } from '@mandalika/api'
import { format } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  ShoppingBag,
  TrendingUp,
  Package,
  Users,
  Crown,
  ArrowDownNarrowWide,
  PackageX,
  Tag,
} from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { BRAND } from '../lib/brand'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { EmptyState } from '../ui/EmptyState'
import { CHART_SERIES } from '../ui/chartColors'
import { KpiCard, RankedList } from './dashboard/components'
import {
  type Period,
  PERIOD_TABS,
  periodInterval,
  prevInterval,
  completedIn,
  computeKpis,
  delta,
  buildTrend,
  productRanking,
  lowStock,
  promoUsage,
  paymentBreakdown,
  cashierPerformance,
} from './dashboard/metrics'

// recharts is code-split out of the dashboard's initial bundle; the chart bodies
// live in ./dashboard/Charts and load on first render behind a sized fallback.
const TrendChart = lazy(() =>
  import('./dashboard/Charts').then((m) => ({ default: m.TrendChart })),
)
const PaymentChart = lazy(() =>
  import('./dashboard/Charts').then((m) => ({ default: m.PaymentChart })),
)
const CashierChart = lazy(() =>
  import('./dashboard/Charts').then((m) => ({ default: m.CashierChart })),
)

/** Height-reserving placeholder so lazy chart loading does not shift layout. */
function ChartFallback({ height }: { height: number }) {
  return <div className="animate-pulse bg-gray-50 rounded-xl" style={{ height }} />
}

export default function Dashboard() {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const [period, setPeriod] = useState<Period>('7d')

  const oq = usePolledQuery<Order[]>(
    () => fetchAllPages((page, limit) => api.listOrders({ page, limit })),
    [outletId],
  )
  const pq = usePolledQuery<Product[]>(
    () => fetchAllPages((page, limit) => api.listProducts(page, limit)),
    [outletId],
  )
  const prq = usePolledQuery<Promotion[]>(() => api.listPromotions(), [outletId])

  if (oq.loading || pq.loading)
    return (
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 animate-pulse h-28" />
        ))}
      </div>
    )

  if (!oq.data || !pq.data) return <p role="alert" className="p-6 text-red-600">Gagal memuat data lengkap. {oq.error || pq.error}</p>

  const orders = oq.data ?? []
  const products = pq.data ?? []
  const promotions = prq.data ?? []

  const now = new Date()
  const iv = periodInterval(period, now)
  const ivPrev = prevInterval(period, now)
  const completed = completedIn(orders, iv)
  const completedPrev = ivPrev ? completedIn(orders, ivPrev) : []

  const kpis = computeKpis(completed)
  const kpisPrev = computeKpis(completedPrev)

  const trend = buildTrend(completed, period, now)
  const trendEmpty = trend.every((t) => t.revenue === 0)
  const ranking = productRanking(completed)
  const top = ranking.slice(0, 10)
  const bottom = [...ranking].reverse().slice(0, 10)
  const stock = lowStock(products)
  const outCount = stock.filter((s) => s.stock <= 0).length
  const lowCount = stock.length - outCount
  const promo = promoUsage(completed, promotions)
  const pay = paymentBreakdown(completed)
  const payTotal = pay.reduce((s, p) => s + p.amount, 0)
  const cashiers = cashierPerformance(completed)

  const aov = kpis.orders ? kpis.revenue / kpis.orders : 0

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`Selamat datang, ${user?.displayName.split(' ')[0]} 👋`}
        subtitle={format(now, 'EEEE, d MMMM yyyy', { locale: idLocale })}
        actions={<Tabs value={period} onChange={setPeriod} tabs={PERIOD_TABS} />}
      />

      {(oq.error || pq.error) && <p role="alert" className="text-sm text-red-600">Gagal memperbarui data lengkap; menampilkan data sebelumnya. {oq.error || pq.error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Penjualan"
          value={BRAND.currency.format(kpis.revenue)}
          sub={`${kpis.orders} transaksi`}
          icon={<TrendingUp className="w-5 h-5" />}
          deltaPct={delta(kpis.revenue, ivPrev ? kpisPrev.revenue : null)}
        />
        <KpiCard
          label="Transaksi"
          value={String(kpis.orders)}
          sub={`${BRAND.currency.format(Math.round(aov))} / transaksi`}
          icon={<ShoppingBag className="w-5 h-5" />}
          deltaPct={delta(kpis.orders, ivPrev ? kpisPrev.orders : null)}
        />
        <KpiCard
          label="Produk Terjual"
          value={kpis.itemsSold.toLocaleString('id-ID')}
          sub={`${ranking.length} jenis produk`}
          icon={<Package className="w-5 h-5" />}
          deltaPct={delta(kpis.itemsSold, ivPrev ? kpisPrev.itemsSold : null)}
        />
        <KpiCard
          label="Pelanggan"
          value={String(kpis.customers)}
          sub="pelanggan teridentifikasi"
          icon={<Users className="w-5 h-5" />}
          deltaPct={delta(kpis.customers, ivPrev ? kpisPrev.customers : null)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <h3 className="font-black text-gray-900 mb-4">Tren Penjualan</h3>
          {trendEmpty ? (
            <div className="h-52 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data penjualan
            </div>
          ) : (
            <Suspense fallback={<ChartFallback height={220} />}>
              <TrendChart trend={trend} />
            </Suspense>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="font-black text-gray-900 mb-4">Metode Pembayaran</h3>
          {pay.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data
            </div>
          ) : (
            <>
              <Suspense fallback={<ChartFallback height={150} />}>
                <PaymentChart pay={pay} />
              </Suspense>
              <div className="mt-3 space-y-1.5">
                {pay.map((p, i) => (
                  <div key={p.method} className="flex items-center gap-2 text-xs">
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                    />
                    <span className="text-gray-600 flex-1">{p.label}</span>
                    <span className="font-bold text-gray-900">{BRAND.currency.format(p.amount)}</span>
                    <span className="text-gray-400 tabular-nums w-9 text-right">
                      {payTotal > 0 ? Math.round((p.amount / payTotal) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Crown className="w-4 h-4 text-gold-600" />
            <h3 className="font-black text-gray-900">Produk Penjualan Teratas</h3>
          </div>
          <RankedList
            rows={top.map((p) => ({ name: p.name, right: `${p.qty.toLocaleString('id-ID')} Pcs` }))}
            empty="Belum ada penjualan"
          />
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <ArrowDownNarrowWide className="w-4 h-4 text-gold-600" />
            <h3 className="font-black text-gray-900">Produk Penjualan Terbawah</h3>
          </div>
          <RankedList
            rows={bottom.map((p) => ({ name: p.name, right: `${p.qty.toLocaleString('id-ID')} Pcs` }))}
            empty="Belum ada penjualan"
          />
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <PackageX className="w-4 h-4 text-gold-600" />
              <h3 className="font-black text-gray-900">Barang Habis</h3>
            </div>
            {stock.length > 0 && (
              <span className="text-xs font-bold text-gray-400">
                {outCount} habis · {lowCount} menipis
              </span>
            )}
          </div>
          {stock.length === 0 ? (
            <EmptyState icon={<PackageX />} title="Semua stok aman" />
          ) : (
            <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
              {stock.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-gray-600 truncate min-w-0">{s.name}</span>
                  {s.stock <= 0 ? (
                    <Badge tone="danger">Habis</Badge>
                  ) : (
                    <Badge tone="warning">Sisa {s.stock}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="w-4 h-4 text-gold-600" />
            <h3 className="font-black text-gray-900">Promosi</h3>
          </div>
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-400 font-bold">Total Penggunaan</p>
              <p className="text-xl font-black text-gray-900">{promo.totalCount}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400 font-bold">Total Jumlah Promo</p>
              <p className="text-xl font-black text-gray-900">
                {BRAND.currency.format(promo.totalAmount)}
              </p>
            </div>
          </div>
          <RankedList
            rows={promo.rows.map((r) => ({
              name: r.name,
              right: <span className={r.count === 0 ? 'text-gray-300' : ''}>{r.count}</span>,
            }))}
            empty="Belum ada promosi"
          />
        </Card>

        <Card className="lg:col-span-2 p-5">
          <h3 className="font-black text-gray-900 mb-4">Performa Kasir</h3>
          {cashiers.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data
            </div>
          ) : (
            <Suspense fallback={<ChartFallback height={Math.max(200, cashiers.length * 36)} />}>
              <CashierChart cashiers={cashiers} />
            </Suspense>
          )}
        </Card>
      </div>
    </div>
  )
}
