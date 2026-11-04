import type { DashboardAggregate, DashboardAggregateParams, Order, Promotion } from '@mandalika/api'
import { eachMonthOfInterval, format, parseISO, startOfDay, startOfMonth, subDays } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { localDay } from '../../lib/businessDay'
import {
  type CashierRow,
  type NetKpis,
  type PayRow,
  type Period,
  type PromoUsage,
  type ProductRow,
  type TrendPoint,
  buildTrend,
  cashierPerformance,
  completedIn,
  computeKpis,
  delta,
  netKpis,
  netPaymentBreakdown,
  paymentBreakdown,
  payLabel,
  periodInterval,
  prevInterval,
  productRanking,
  promoUsage,
  promoUsageFromTally,
  refundsIn,
  salesIn,
} from './metrics'

/**
 * Everything Ringkasan renders from orders. Two producers: `viewFromAggregate` (the server aggregate,
 * the normal path) and `viewFromOrders` (today's client computation over the full order list, the
 * fallback for a backend without GET /reports/dashboard and the parity oracle in tests).
 */
export interface DashboardView {
  /** Net money of the window; null only when the refund side was unavailable (fallback on an old backend). */
  net: NetKpis | null
  /** Penjualan: net sales, or completed-only revenue when `net` is null. */
  revenue: number
  deltaRevenue: number | null
  orders: number
  deltaOrders: number | null
  /** Average order value: still-sold revenue / orders. */
  aov: number
  itemsSold: number
  deltaItems: number | null
  customers: number
  deltaCustomers: number | null
  trend: TrendPoint[]
  trendEmpty: boolean
  pay: PayRow[]
  top: ProductRow[]
  bottom: ProductRow[]
  /** "N jenis produk": distinct product+variant rows of the ranking. */
  distinctProducts: number
  promo: PromoUsage
  cashiers: CashierRow[]
}

const TOP_N = 10

/** The server aggregate's query for a period: the same windows the client math used, from the browser clock. */
export function dashboardAggregateParams(period: Period, now: Date): DashboardAggregateParams {
  const cur = periodInterval(period, now)
  const prev = prevInterval(period, now)
  const params: DashboardAggregateParams = {
    dateTo: localDay(cur.end),
    trend: period === 'today' ? 'hour' : period === 'all' ? 'month' : 'day',
  }
  if (period !== 'all') params.dateFrom = localDay(cur.start)
  if (prev) {
    params.prevDateFrom = localDay(prev.start)
    params.prevDateTo = localDay(prev.end)
  }
  // Hour buckets follow the viewer's clock, like the client's getHours() always did.
  if (period === 'today') params.tzOffset = -now.getTimezoneOffset()
  return params
}

/** Today's computation, moved out of Dashboard.tsx unchanged. `refundRows` null = refund side unavailable. */
export function viewFromOrders(
  orders: Order[],
  refundRows: Order[] | null,
  period: Period,
  now: Date,
  promotions: readonly Promotion[],
): DashboardView {
  const iv = periodInterval(period, now)
  const ivPrev = prevInterval(period, now)
  const completed = completedIn(orders, iv)
  const completedPrev = ivPrev ? completedIn(orders, ivPrev) : []
  const kpis = computeKpis(completed)
  const kpisPrev = computeKpis(completedPrev)
  // Net = gross sales by sale day minus refunds by refund day; completed-only when refunds are unknown.
  const net = refundRows ? netKpis(orders, refundRows, iv) : null
  const netPrev = refundRows && ivPrev ? netKpis(orders, refundRows, ivPrev) : null
  const revenue = net ? net.net : kpis.revenue
  const revenuePrev = netPrev ? netPrev.net : kpisPrev.revenue
  const trend = refundRows
    ? buildTrend(salesIn(orders, iv), period, now, refundsIn(refundRows, iv))
    : buildTrend(completed, period, now)
  const trendEmpty =
    trend.every((t) => t.revenue === 0 && t.orders === 0) && !(refundRows && refundsIn(refundRows, iv).length > 0)
  const ranking = productRanking(completed)
  return {
    net,
    revenue,
    deltaRevenue: delta(revenue, ivPrev ? revenuePrev : null),
    orders: kpis.orders,
    deltaOrders: delta(kpis.orders, ivPrev ? kpisPrev.orders : null),
    aov: kpis.orders ? kpis.revenue / kpis.orders : 0,
    itemsSold: kpis.itemsSold,
    deltaItems: delta(kpis.itemsSold, ivPrev ? kpisPrev.itemsSold : null),
    customers: kpis.customers,
    deltaCustomers: delta(kpis.customers, ivPrev ? kpisPrev.customers : null),
    trend,
    trendEmpty,
    pay: refundRows ? netPaymentBreakdown(orders, refundRows, iv) : paymentBreakdown(completed),
    top: ranking.slice(0, TOP_N),
    bottom: [...ranking].reverse().slice(0, TOP_N),
    distinctProducts: ranking.length,
    promo: promoUsage(completed, [...promotions]),
    cashiers: cashierPerformance(completed),
  }
}

/** The trend skeleton of buildTrend, filled from the server's sparse buckets (revenue = sales - refunds). */
export function trendFromBuckets(buckets: DashboardAggregate['trend'], period: Period, now: Date): TrendPoint[] {
  const fill = (points: TrendPoint[], byKey: Map<string, TrendPoint>) => {
    for (const b of buckets) {
      const p = byKey.get(b.bucket)
      if (p) {
        p.revenue += b.sales - b.refunds
        p.orders += b.orders
      }
    }
    return points
  }
  if (period === 'today') {
    const points: TrendPoint[] = Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, '0'), revenue: 0, orders: 0 }))
    return fill(points, new Map(points.map((p) => [p.label, p])))
  }
  if (period === 'all') {
    if (buckets.length === 0) return []
    let min = buckets[0].bucket
    for (const b of buckets) if (b.bucket < min) min = b.bucket
    const byMonth = new Map<string, TrendPoint>()
    const points = eachMonthOfInterval({ start: startOfMonth(parseISO(`${min}-01`)), end: now }).map((m) => {
      const p: TrendPoint = { label: format(m, 'MMM yy', { locale: idLocale }), revenue: 0, orders: 0 }
      byMonth.set(format(m, 'yyyy-MM'), p)
      return p
    })
    return fill(points, byMonth)
  }
  const days = period === '7d' ? 7 : 30
  const byDay = new Map<string, TrendPoint>()
  const points = Array.from({ length: days }, (_, i) => {
    const d = subDays(startOfDay(now), days - 1 - i)
    const p: TrendPoint = { label: format(d, days === 7 ? 'EEE' : 'd/M', { locale: idLocale }), revenue: 0, orders: 0 }
    byDay.set(format(d, 'yyyy-MM-dd'), p)
    return p
  })
  return fill(points, byDay)
}

/** The same screen numbers from the server aggregate. `now` must be the instant the request's windows were built from. */
export function viewFromAggregate(
  agg: DashboardAggregate,
  period: Period,
  now: Date,
  promotions: readonly Promotion[],
): DashboardView {
  const cur = agg.current
  const prev = agg.previous
  const net: NetKpis = { gross: cur.gross, grossCount: cur.grossCount, refunds: cur.refunds, refundedCount: cur.refundedCount, net: cur.net }
  const trend = trendFromBuckets(agg.trend, period, now)
  const methods = new Set([...Object.keys(agg.grossByPaymentMethod), ...Object.keys(agg.refundsByPaymentMethod)])
  const pay: PayRow[] = [...methods]
    .map((method) => ({
      method,
      label: payLabel(method),
      amount: (agg.grossByPaymentMethod[method] ?? 0) - (agg.refundsByPaymentMethod[method] ?? 0),
    }))
    .sort((a, b) => b.amount - a.amount || (a.method < b.method ? -1 : 1))
  const productRow = (r: DashboardAggregate['topProducts'][number]): ProductRow => ({
    key: `${r.productId}|${r.variantSize}`,
    name: `${r.productName}${r.variantSize ? ` ${r.variantSize}` : ''}`.trim(),
    qty: r.qty,
  })
  const tally = new Map(agg.promoTally.map((r) => [r.label, { count: r.count, amount: r.amount }]))
  return {
    net,
    revenue: cur.net,
    deltaRevenue: delta(cur.net, prev ? prev.net : null),
    orders: cur.orders,
    deltaOrders: delta(cur.orders, prev ? prev.orders : null),
    aov: cur.orders ? cur.stillSoldRevenue / cur.orders : 0,
    itemsSold: cur.itemsSold,
    deltaItems: delta(cur.itemsSold, prev ? prev.itemsSold : null),
    customers: cur.customers,
    deltaCustomers: delta(cur.customers, prev ? prev.customers : null),
    trend,
    trendEmpty: trend.every((t) => t.revenue === 0 && t.orders === 0) && cur.refundedCount === 0,
    pay,
    top: agg.topProducts.map(productRow),
    bottom: agg.bottomProducts.map(productRow),
    distinctProducts: agg.distinctProducts,
    promo: promoUsageFromTally(tally, promotions),
    cashiers: agg.cashiers.map((c) => ({ id: c.id, name: c.name, transactions: c.transactions, revenue: c.revenue })),
  }
}
