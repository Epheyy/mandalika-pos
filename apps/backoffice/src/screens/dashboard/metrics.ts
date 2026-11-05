import type { Order, Product, Promotion } from '@mandalika/api'
import {
  parseISO,
  startOfDay,
  endOfDay,
  subDays,
  format,
  eachMonthOfInterval,
  startOfMonth,
} from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { localDay } from '../../lib/businessDay'
import { canonicalMethodLabel, groupPayRows } from '../../lib/paymentLabel'
import { hasRefundIn, isRefundedStatus, methodNetRows, refundedMoney, refundSlices, reportTotals, stillSoldMoney, type RefundWindow } from '../reports/reportTotals'

export type Period = 'today' | '7d' | '30d' | 'all'

export const PERIOD_TABS: ReadonlyArray<{ id: Period; label: string }> = [
  { id: 'today', label: 'Hari Ini' },
  { id: '7d', label: '7 Hari' },
  { id: '30d', label: '30 Hari' },
  { id: 'all', label: 'Semua' },
]

export interface Interval {
  start: Date
  end: Date
}

/** The active window for a period. `all` starts at the epoch. */
export function periodInterval(period: Period, now = new Date()): Interval {
  const end = endOfDay(now)
  switch (period) {
    case 'today':
      return { start: startOfDay(now), end }
    case '7d':
      return { start: startOfDay(subDays(now, 6)), end }
    case '30d':
      return { start: startOfDay(subDays(now, 29)), end }
    case 'all':
      return { start: new Date(0), end }
  }
}

/** The immediately-preceding window of equal length, for deltas. Null for `all`. */
export function prevInterval(period: Period, now = new Date()): Interval | null {
  switch (period) {
    case 'today':
      return { start: startOfDay(subDays(now, 1)), end: endOfDay(subDays(now, 1)) }
    case '7d':
      return { start: startOfDay(subDays(now, 13)), end: endOfDay(subDays(now, 7)) }
    case '30d':
      return { start: startOfDay(subDays(now, 59)), end: endOfDay(subDays(now, 30)) }
    case 'all':
      return null
  }
}

/**
 * The business day (YYYY-MM-DD) of an order: the server stamps it in the OUTLET's zone (a shift's
 * sales take the shift's opening day). Falls back to the browser-local day of createdAt for rows
 * without it (older cached data).
 */
export function businessDayOf(o: Order): string {
  if (o.businessDate) return o.businessDate
  try {
    return localDay(parseISO(o.createdAt))
  } catch {
    return ''
  }
}

/**
 * Server date window (business days) that covers the current AND previous interval, so the
 * dashboard downloads only what it renders. `all` stays unbounded (the owner asked for "Semua").
 */
export function dashboardFetchWindow(period: Period, now = new Date()): { dateFrom?: string; dateTo?: string } {
  if (period === 'all') return {}
  const start = (prevInterval(period, now) ?? periodInterval(period, now)).start
  return { dateFrom: localDay(start), dateTo: localDay(now) }
}

/** Completed (and C4a partially refunded) orders whose business day falls in the interval (inclusive of both end days). */
export function completedIn(orders: Order[], iv: Interval): Order[] {
  const from = localDay(iv.start)
  const to = localDay(iv.end)
  return orders.filter((o) => {
    if (o.status !== 'completed' && o.status !== 'partially_refunded') return false
    const day = businessDayOf(o)
    return day !== '' && day >= from && day <= to
  })
}

/** Sales (completed + partially refunded + refunded, never cancelled) whose SALE business day falls in the interval. */
export function salesIn(orders: readonly Order[], iv: Interval): Order[] {
  const from = localDay(iv.start)
  const to = localDay(iv.end)
  return orders.filter((o) => {
    if (o.status !== 'completed' && o.status !== 'partially_refunded' && o.status !== 'refunded') return false
    const day = businessDayOf(o)
    return day !== '' && day >= from && day <= to
  })
}

/**
 * The business day a refund is recognised on (A27): the server's refundBusinessDate, else the
 * browser-local day of refundedAt. A partially refunded order has neither on the order row, so the
 * latest refunds[] entry stands in (the server summary splits a multi-day order exactly; this
 * client oracle books it whole on the last refund day). Empty when nothing exists.
 */
export function refundBusinessDayOf(o: Order): string {
  const last = o.refunds && o.refunds.length > 0 ? o.refunds[o.refunds.length - 1] : undefined
  const bd = o.refundBusinessDate ?? last?.refundBusinessDate
  if (bd) return bd
  const at = o.refundedAt ?? last?.refundedAt
  if (!at) return ''
  try {
    return localDay(parseISO(at))
  } catch {
    return ''
  }
}

const intervalWindow = (iv: Interval): RefundWindow => ({ from: localDay(iv.start), to: localDay(iv.end) })

/**
 * What a refund order subtracts and where: one entry per refunds[] row on its own day, or (older
 * backend, no refunds[]) the whole refundedAmount ?? total on the row's refund day.
 */
function refundDeltas(o: Order): Array<{ day: string; at: string; amount: number }> {
  const slices = refundSlices(o)
  if (slices) return slices.map((s) => ({ day: s.day, at: s.at ?? o.createdAt, amount: s.amount }))
  return [{ day: refundBusinessDayOf(o), at: o.refundedAt ?? o.createdAt, amount: refundedMoney(o) }]
}

/** Refunded and partially refunded rows whose REFUND business day falls in the interval. */
export function refundsIn(orders: readonly Order[], iv: Interval): Order[] {
  const from = localDay(iv.start)
  const to = localDay(iv.end)
  return orders.filter((o) => {
    if (!isRefundedStatus(o.status)) return false
    if (o.refunds) return hasRefundIn(o, { from, to })
    const day = refundBusinessDayOf(o)
    return day !== '' && day >= from && day <= to
  })
}

/**
 * Validates the `dateBasis=refund` response. A backend that predates A27 ignores the parameter and
 * returns ordinary rows (not all refunded, no refundBusinessDate key); using them would corrupt the
 * net, so the caller falls back to completed-only numbers when this returns null.
 */
export function refundSideOrNull(rows: readonly Order[]): Order[] | null {
  for (const o of rows) {
    if (!isRefundedStatus(o.status)) return null
    // A partially refunded row carries its days in refunds[]; a refunded row keeps the A27 key.
    if (o.status === 'refunded' && o.refundBusinessDate === undefined) return null
  }
  return [...rows]
}

export interface NetKpis {
  gross: number
  grossCount: number
  refunds: number
  refundedCount: number
  /** gross - refunds; may be negative. */
  net: number
}

/** Net sales for the interval: sales by sale day minus refunds by refund day (same as Ekspor "Bersih"). */
export function netKpis(saleRows: readonly Order[], refundRows: readonly Order[], iv: Interval): NetKpis {
  const t = reportTotals(salesIn(saleRows, iv), refundsIn(refundRows, iv), intervalWindow(iv))
  return { gross: t.gross, grossCount: t.grossCount, refunds: t.refunds, refundedCount: t.refundedCount, net: t.net }
}

export interface Kpis {
  revenue: number
  orders: number
  itemsSold: number
  customers: number
}

/** Units of a line still sold: a partially refunded order gives back its refundedQty. */
const soldQty = (o: Order, it: Order['items'][number]): number =>
  o.status === 'partially_refunded' ? Math.max(it.quantity - (it.refundedQty ?? 0), 0) : it.quantity

export function computeKpis(completed: Order[]): Kpis {
  let revenue = 0
  let itemsSold = 0
  const customers = new Set<string>()
  for (const o of completed) {
    revenue += stillSoldMoney(o)
    for (const it of o.items) itemsSold += soldQty(o, it)
    if (o.customerId) customers.add(o.customerId)
  }
  return { revenue, orders: completed.length, itemsSold, customers: customers.size }
}

/**
 * Percent change cur vs prev; null when prev is unavailable or not positive (a percentage off a zero or
 * negative base is meaningless and read as a false "+100%"). A real drop to 0 from a positive base is -100%.
 */
export function delta(cur: number, prev: number | null): number | null {
  if (prev === null || prev <= 0) return null
  return ((cur - prev) / prev) * 100
}

export interface TrendPoint {
  label: string
  revenue: number
  orders: number
}

/**
 * Buckets sized to the period: hourly (today), daily (7d/30d), monthly (all). `completed` are the
 * sale rows (bucketed by sale day); `refunds` are subtracted from their REFUND day (hour of
 * refundedAt in the hourly view), so a point can be negative.
 */
export function buildTrend(
  completed: Order[],
  period: Period,
  now = new Date(),
  refunds: readonly Order[] = [],
): TrendPoint[] {
  if (period === 'today') {
    const buckets: TrendPoint[] = Array.from({ length: 24 }, (_, h) => ({
      label: String(h).padStart(2, '0'),
      revenue: 0,
      orders: 0,
    }))
    for (const o of completed) {
      const h = parseISO(o.createdAt).getHours()
      buckets[h].revenue += o.total
      buckets[h].orders += 1
    }
    const today = localDay(now)
    for (const o of refunds) {
      for (const d of refundDeltas(o)) {
        // Only refund rows of today land in the hourly view; an older backend row is booked whole.
        if (o.refunds && d.day !== today) continue
        buckets[parseISO(d.at).getHours()].revenue -= d.amount
      }
    }
    return buckets
  }

  if (period === 'all') {
    if (completed.length === 0 && refunds.length === 0) return []
    const days = [...completed.map(businessDayOf), ...refunds.map(refundBusinessDayOf)].filter((d) => d !== '')
    if (days.length === 0) return []
    let min = parseISO(days[0])
    for (const d of days) {
      const pd = parseISO(d)
      if (pd < min) min = pd
    }
    const months = eachMonthOfInterval({ start: startOfMonth(min), end: now })
    const byMonth = new Map<string, TrendPoint>()
    const points = months.map((m) => {
      const p: TrendPoint = { label: format(m, 'MMM yy', { locale: idLocale }), revenue: 0, orders: 0 }
      byMonth.set(format(m, 'yyyy-MM'), p)
      return p
    })
    for (const o of completed) {
      const p = byMonth.get(businessDayOf(o).slice(0, 7))
      if (p) {
        p.revenue += o.total
        p.orders += 1
      }
    }
    for (const o of refunds) {
      for (const d of refundDeltas(o)) {
        const p = byMonth.get(d.day.slice(0, 7))
        if (p) p.revenue -= d.amount
      }
    }
    return points
  }

  const days = period === '7d' ? 7 : 30
  const byDay = new Map<string, TrendPoint>()
  const points = Array.from({ length: days }, (_, i) => {
    const d = subDays(startOfDay(now), days - 1 - i)
    const p: TrendPoint = {
      label: format(d, days === 7 ? 'EEE' : 'd/M', { locale: idLocale }),
      revenue: 0,
      orders: 0,
    }
    byDay.set(format(d, 'yyyy-MM-dd'), p)
    return p
  })
  for (const o of completed) {
    const p = byDay.get(businessDayOf(o))
    if (p) {
      p.revenue += o.total
      p.orders += 1
    }
  }
  for (const o of refunds) {
    for (const d of refundDeltas(o)) {
      const p = byDay.get(d.day)
      if (p) p.revenue -= d.amount
    }
  }
  return points
}

export interface ProductRow {
  key: string
  name: string
  qty: number
}

/** Items aggregated by product+variant, sorted by quantity sold (desc). */
export function productRanking(completed: Order[]): ProductRow[] {
  const map = new Map<string, ProductRow>()
  for (const o of completed) {
    for (const it of o.items) {
      const name = `${it.productName}${it.variantSize ? ` ${it.variantSize}` : ''}`.trim()
      const key = `${it.productId}|${it.variantSize}`
      const row = map.get(key) ?? { key, name, qty: 0 }
      row.qty += soldQty(o, it)
      map.set(key, row)
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty)
}

export interface StockRow {
  name: string
  stock: number
}

/** Variants at or below their PAR level (per-outlet) — or `threshold` when no PAR
 *  is set — out-of-stock first. */
export function lowStock(products: Product[], threshold = 5): StockRow[] {
  const rows: StockRow[] = []
  for (const p of products) {
    if (p.isActive === false) continue
    for (const v of p.variants) {
      const par = v.parLevel ?? threshold
      if (v.stock <= par) {
        rows.push({ name: `${p.name}${v.size ? ` ${v.size}` : ''}`.trim(), stock: v.stock })
      }
    }
  }
  return rows.sort((a, b) => a.stock - b.stock)
}

export interface PromoRow {
  name: string
  count: number
  amount: number
}

export interface PromoUsage {
  rows: PromoRow[]
  totalCount: number
  totalAmount: number
}

/** Promo usage tallied from order discount breakdowns, joined to all promotions
 *  (promotions with no usage appear with 0). Manual discounts/codes that don't
 *  match a promotion name are excluded — totals cover the listed promotions. */
export function promoUsage(completed: Order[], promotions: Promotion[]): PromoUsage {
  const tally = new Map<string, { count: number; amount: number }>()
  for (const o of completed) {
    const comps =
      o.discountBreakdown && o.discountBreakdown.length > 0
        ? o.discountBreakdown.map((c) => ({ label: c.label, amount: c.amount }))
        : o.discountLabel
          ? [{ label: o.discountLabel, amount: o.discountAmount }]
          : []
    for (const c of comps) {
      if (!c.label) continue
      const t = tally.get(c.label) ?? { count: 0, amount: 0 }
      t.count += 1
      t.amount += c.amount || 0
      tally.set(c.label, t)
    }
  }
  return promoUsageFromTally(tally, promotions)
}

/** The tally joined to every listed promotion (unused ones with 0), most used first; shared with the server aggregate path. */
export function promoUsageFromTally(
  tally: ReadonlyMap<string, { count: number; amount: number }>,
  promotions: readonly Promotion[],
): PromoUsage {
  const rows: PromoRow[] = promotions
    .map((p) => {
      const t = tally.get(p.name)
      return { name: p.name, count: t?.count ?? 0, amount: t?.amount ?? 0 }
    })
    .sort((a, b) => b.count - a.count || b.amount - a.amount)
  const totalCount = rows.reduce((s, r) => s + r.count, 0)
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0)
  return { rows, totalCount, totalAmount }
}

/** Display label of a payment method id (case-insensitive; see lib/paymentLabel). */
export const payLabel = (method: string): string => canonicalMethodLabel(method)

export interface PayRow {
  method: string
  label: string
  amount: number
}

export function paymentBreakdown(completed: Order[]): PayRow[] {
  // C6a: per (order, method) row (tenders[] lines minus refunds paid out in that method); an older
  // backend or pre-C6 order falls back to one row keyed by the order method. Grouped by canonical code.
  const pairs: [string, number][] = []
  for (const o of completed) for (const r of methodNetRows(o)) pairs.push([r.method, r.net])
  return groupPayRows(pairs)
}

/** Payment mix as NET money (gross by sale day minus refunds by refund day, per original method). */
export function netPaymentBreakdown(
  saleRows: readonly Order[],
  refundRows: readonly Order[],
  iv: Interval,
): PayRow[] {
  const t = reportTotals(salesIn(saleRows, iv), refundsIn(refundRows, iv), intervalWindow(iv))
  const methods = new Set([...Object.keys(t.grossByPay), ...Object.keys(t.refundsByPay)])
  return groupPayRows([...methods].map((m) => [m, (t.grossByPay[m] ?? 0) - (t.refundsByPay[m] ?? 0)] as const))
}

export interface CashierRow {
  id: string
  name: string
  transactions: number
  revenue: number
}

export function cashierPerformance(completed: Order[], limit = 8): CashierRow[] {
  const map = new Map<string, CashierRow>()
  for (const o of completed) {
    const row = map.get(o.cashierId) ?? {
      id: o.cashierId,
      name: o.cashierName,
      transactions: 0,
      revenue: 0,
    }
    row.transactions += 1
    row.revenue += stillSoldMoney(o)
    map.set(o.cashierId, row)
  }
  return [...map.values()].sort((a, b) => b.transactions - a.transactions).slice(0, limit)
}
