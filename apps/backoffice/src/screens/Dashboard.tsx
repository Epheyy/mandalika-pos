import { lazy, Suspense } from 'react'
import type { Promotion } from '@mandalika/api'
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
import { useCachedList } from '../hooks/useCachedList'
import { productCatalogue } from '../lib/productCatalogue'
import { BRAND } from '../lib/brand'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { EmptyState } from '../ui/EmptyState'
import { CHART_SERIES } from '../ui/chartColors'
import { KpiCard, RankedList } from './dashboard/components'
import { useListState } from '../lib/router/useListState'
import { DASHBOARD_SCHEMA, periodFromSlug, periodSlug } from './dashboard/periodRoute'
import { type Period, PERIOD_TABS, dashboardFetchWindow, lowStock } from './dashboard/metrics'
import { DASHBOARD_POLL_MS, dashboardView, fetchDashboard, type DashboardData } from './dashboard/fetchDashboard'

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

/** The low-stock card reads the shared product list, at most this stale (it used to be re-read every 12 s). */
const DASHBOARD_CATALOGUE_MAX_AGE_MS = 60_000
const DASHBOARD_PROMO_POLL_MS = 60_000

export default function Dashboard() {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  // The period is in the URL (#/ringkasan?periode=30h); the default stays out of it.
  const [query, setQuery] = useListState(DASHBOARD_SCHEMA)
  const period = periodFromSlug(query.periode)
  const setPeriod = (p: Period) => setQuery({ periode: periodSlug(p) })

  // One poll = one request: the server aggregate of the period (+ previous period for deltas) computed from the
  // same windows the client math used. A backend without the route (404/405) falls back to today's computation over
  // the full order lists (see fetchDashboard); the window deps below keep the poll sliding past midnight.
  const win = dashboardFetchWindow(period)
  const oq = usePolledQuery<DashboardData>(
    () => fetchDashboard(api, period, Date.now(), `${user?.id ?? ''}|${outletId ?? ''}`),
    [outletId, period, win.dateFrom, win.dateTo],
    DASHBOARD_POLL_MS,
  )
  // Only the low-stock card and the promo names read these: the shared product list (served for up to a minute, then
  // refreshed while the tab stays open) and the promotion list on a minute poll, so the order polls above stay the
  // only 12 s traffic. The order numbers do not depend on either.
  const pq = useCachedList(productCatalogue, { maxAgeMs: DASHBOARD_CATALOGUE_MAX_AGE_MS })
  const prq = usePolledQuery<Promotion[]>(() => api.listPromotions(), [outletId], DASHBOARD_PROMO_POLL_MS)

  if (oq.loading || pq.loading)
    return (
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="surface-card rounded-2xl p-5 animate-pulse h-28" />
        ))}
      </div>
    )

  if (!oq.data || !pq.data) return <p role="alert" className="p-6 text-danger">Gagal memuat data lengkap. {oq.error || pq.error}</p>

  const products = pq.data ?? []
  const promotions = prq.data ?? []

  const now = new Date()
  const v = dashboardView(oq.data, period, promotions)
  const net = v.net
  const stock = lowStock(products)
  const outCount = stock.filter((s) => s.stock <= 0).length
  const lowCount = stock.length - outCount
  const { trend, trendEmpty, pay, promo, cashiers } = v
  const payPositive = pay.filter((p) => p.amount > 0)
  const payTotal = payPositive.reduce((s, p) => s + p.amount, 0)

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`Selamat datang, ${user?.displayName.split(' ')[0]} 👋`}
        subtitle={format(now, 'EEEE, d MMMM yyyy', { locale: idLocale })}
        actions={<Tabs value={period} onChange={setPeriod} tabs={PERIOD_TABS} />}
      />

      {(oq.error || pq.error) && <p role="alert" className="text-sm text-danger">Gagal memperbarui data lengkap; menampilkan data sebelumnya. {oq.error || pq.error}</p>}
      {!net && (
        <p className="text-xs text-gray-400">
          Data refund belum tersedia; penjualan menampilkan transaksi selesai saja (belum dikurangi refund).
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Penjualan"
          value={BRAND.currency.format(v.revenue)}
          sub={
            net
              ? `Kotor ${BRAND.currency.format(net.gross)} / Refund ${BRAND.currency.format(net.refunds)}`
              : `${v.orders} transaksi`
          }
          icon={<TrendingUp className="w-5 h-5" />}
          deltaPct={v.deltaRevenue}
        />
        <KpiCard
          label="Transaksi"
          value={String(v.orders)}
          sub={`${BRAND.currency.format(Math.round(v.aov))} / transaksi`}
          icon={<ShoppingBag className="w-5 h-5" />}
          deltaPct={v.deltaOrders}
        />
        <KpiCard
          label="Produk Terjual"
          value={v.itemsSold.toLocaleString('id-ID')}
          sub={`${v.distinctProducts} jenis produk`}
          icon={<Package className="w-5 h-5" />}
          deltaPct={v.deltaItems}
        />
        <KpiCard
          label="Pelanggan"
          value={String(v.customers)}
          sub="pelanggan teridentifikasi"
          icon={<Users className="w-5 h-5" />}
          deltaPct={v.deltaCustomers}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <h3 className="font-black text-gray-900 mb-4">{net ? 'Tren Penjualan (Bersih)' : 'Tren Penjualan'}</h3>
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
                <PaymentChart pay={payPositive} />
              </Suspense>
              <div className="mt-3 space-y-1.5">
                {pay.map((p, i) => (
                  <div key={p.method} className="flex items-center gap-2 text-xs">
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ background: CHART_SERIES[i % CHART_SERIES.length] }}
                    />
                    <span className="text-ink-700 flex-1">{p.label}</span>
                    <span className="font-bold text-gray-900">{BRAND.currency.format(p.amount)}</span>
                    <span className="text-ink-500 tabular-nums w-9 text-right">
                      {payTotal > 0 && p.amount > 0 ? Math.round((p.amount / payTotal) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Crown className="w-4 h-4 text-brand-strong" />
            <h3 className="font-black text-gray-900">Produk Penjualan Teratas</h3>
          </div>
          <RankedList
            rows={v.top.map((p) => ({ name: p.name, right: `${p.qty.toLocaleString('id-ID')} Pcs` }))}
            empty="Belum ada penjualan"
          />
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <ArrowDownNarrowWide className="w-4 h-4 text-brand-strong" />
            <h3 className="font-black text-gray-900">Produk Penjualan Terbawah</h3>
          </div>
          <RankedList
            rows={v.bottom.map((p) => ({ name: p.name, right: `${p.qty.toLocaleString('id-ID')} Pcs` }))}
            empty="Belum ada penjualan"
          />
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <PackageX className="w-4 h-4 text-brand-strong" />
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
            <div className="divide-y divide-gray-50">
              {stock.map((s) => (
                <div key={s.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="text-ink-700 truncate min-w-0">{s.name}</span>
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
            <Tag className="w-4 h-4 text-brand-strong" />
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
