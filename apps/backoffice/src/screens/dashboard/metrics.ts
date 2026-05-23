import type { Order, Product, Promotion } from '@mandalika/api'
import {
  parseISO,
  startOfDay,
  endOfDay,
  subDays,
  isWithinInterval,
  format,
  eachMonthOfInterval,
  startOfMonth,
} from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

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

export function inInterval(iso: string, iv: Interval): boolean {
  try {
    return isWithinInterval(parseISO(iso), { start: iv.start, end: iv.end })
  } catch {
    return false
  }
}

/** Completed orders whose createdAt falls in the interval. */
export function completedIn(orders: Order[], iv: Interval): Order[] {
  return orders.filter((o) => o.status === 'completed' && inInterval(o.createdAt, iv))
}

export interface Kpis {
  revenue: number
  orders: number
  itemsSold: number
  customers: number
}

export function computeKpis(completed: Order[]): Kpis {
  let revenue = 0
  let itemsSold = 0
  const customers = new Set<string>()
  for (const o of completed) {
    revenue += o.total
    for (const it of o.items) itemsSold += it.quantity
    if (o.customerId) customers.add(o.customerId)
  }
  return { revenue, orders: completed.length, itemsSold, customers: customers.size }
}

/** Percent change cur vs prev; null when prev is 0 or unavailable. */
export function delta(cur: number, prev: number | null): number | null {
  if (prev === null || prev === 0) return null
  return ((cur - prev) / prev) * 100
}

export interface TrendPoint {
  label: string
  revenue: number
  orders: number
}

/** Buckets sized to the period: hourly (today), daily (7d/30d), monthly (all). */
export function buildTrend(completed: Order[], period: Period, now = new Date()): TrendPoint[] {
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
    return buckets
  }

  if (period === 'all') {
    if (completed.length === 0) return []
    let min = parseISO(completed[0].createdAt)
    for (const o of completed) {
      const d = parseISO(o.createdAt)
      if (d < min) min = d
    }
    const months = eachMonthOfInterval({ start: startOfMonth(min), end: now })
    const byMonth = new Map<string, TrendPoint>()
    const points = months.map((m) => {
      const p: TrendPoint = { label: format(m, 'MMM yy', { locale: idLocale }), revenue: 0, orders: 0 }
      byMonth.set(format(m, 'yyyy-MM'), p)
      return p
    })
    for (const o of completed) {
      const p = byMonth.get(o.createdAt.slice(0, 7))
      if (p) {
        p.revenue += o.total
        p.orders += 1
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
    const p = byDay.get(o.createdAt.slice(0, 10))
    if (p) {
      p.revenue += o.total
      p.orders += 1
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
      row.qty += it.quantity
      map.set(key, row)
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty)
}

export interface StockRow {
  name: string
  stock: number
}

/** Variants at or below `threshold`, out-of-stock first. */
export function lowStock(products: Product[], threshold = 5): StockRow[] {
  const rows: StockRow[] = []
  for (const p of products) {
    if (p.isActive === false) continue
    for (const v of p.variants) {
      if (v.stock <= threshold) {
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

const PAY_LABELS: Record<string, string> = {
  cash: 'Tunai',
  card: 'Kartu',
  qris: 'QRIS',
  transfer: 'Transfer',
}

export interface PayRow {
  method: string
  label: string
  amount: number
}

export function paymentBreakdown(completed: Order[]): PayRow[] {
  const map = new Map<string, number>()
  for (const o of completed) map.set(o.paymentMethod, (map.get(o.paymentMethod) ?? 0) + o.total)
  return [...map.entries()]
    .map(([method, amount]) => ({
      method,
      label: PAY_LABELS[method] ?? method.charAt(0).toUpperCase() + method.slice(1),
      amount,
    }))
    .sort((a, b) => b.amount - a.amount)
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
    row.revenue += o.total
    map.set(o.cashierId, row)
  }
  return [...map.values()].sort((a, b) => b.transactions - a.transactions).slice(0, limit)
}
