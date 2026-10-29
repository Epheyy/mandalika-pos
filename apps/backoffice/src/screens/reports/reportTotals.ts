import type { Order } from '@mandalika/api'
import { parseISO } from 'date-fns'
import { localDay } from '../../lib/businessDay'

export interface ReportTotals {
  /** Completed + refunded money by SALE day (a sale stays on its sale day forever). */
  gross: number
  grossCount: number
  /** Still-completed money by sale day (the server's totalSales). */
  revenue: number
  completedCount: number
  /** Refunded money by REFUND day. */
  refunds: number
  refundedCount: number
  /** gross - refunds; may be negative. */
  net: number
  /** Still-completed revenue grouped by the raw payment method string. */
  byPay: Record<string, number>
  grossByPay: Record<string, number>
  /** Refunds grouped by the ORIGINAL payment method. */
  refundsByPay: Record<string, number>
}

/** True for the two states that carry refund money (C4a: partially_refunded joins refunded). */
export const isRefundedStatus = (status: string): boolean => status === 'refunded' || status === 'partially_refunded'

/** Money refunded on an order: the server's sum of refund rows, else the whole total (legacy / older backend). */
export const refundedMoney = (o: Pick<Order, 'total' | 'refundedAmount'>): number => o.refundedAmount ?? o.total

/** Inclusive refund business-day window (YYYY-MM-DD); an absent bound is open. */
export interface RefundWindow { from?: string; to?: string }

/** One refund row of an order placed on its refund business day; method = where it was paid out. */
export interface RefundSlice { day: string; at: string | null; amount: number; method: string }

/**
 * The order's refund rows as slices, or null when the backend sent no refunds[] (older backend:
 * callers fall back to refundedAmount ?? total). The day is the row's refundBusinessDate, else the
 * browser-local day of refundedAt, mirroring the server's refund-basis day. The method is the
 * row's payout method (C6a), else the order's method (a pre-C6 row is a copy of the sale method).
 */
export function refundSlices(o: Pick<Order, 'refunds'> & Partial<Pick<Order, 'paymentMethod'>>): RefundSlice[] | null {
  if (!o.refunds) return null
  return o.refunds.map((r) => {
    let day = r.refundBusinessDate ?? ''
    if (!day && r.refundedAt) {
      try { day = localDay(parseISO(r.refundedAt)) } catch { day = '' }
    }
    return { day, at: r.refundedAt ?? null, amount: r.amount, method: r.paymentMethod || o.paymentMethod || '' }
  })
}

const inWindow = (day: string, w?: RefundWindow): boolean => {
  if (!w) return true
  if (w.from && !(day && day >= w.from)) return false
  if (w.to && !(day && day <= w.to)) return false
  return true
}

/** Refund money of an order inside the window: the in-window refund rows, else refundedAmount ?? total. */
export function refundMoneyIn(o: Pick<Order, 'total' | 'refundedAmount' | 'refunds'>, w?: RefundWindow): number {
  const slices = refundSlices(o)
  if (!slices) return refundedMoney(o)
  return slices.reduce((sum, s) => (inWindow(s.day, w) ? sum + s.amount : sum), 0)
}

/** True when the order has a refund row inside the window (always true without refunds[]: the server already filtered). */
export function hasRefundIn(o: Pick<Order, 'refunds'>, w?: RefundWindow): boolean {
  const slices = refundSlices(o)
  return slices ? slices.some((s) => inWindow(s.day, w)) : true
}

/**
 * Money of a sale still sold. completed = total. A refunded/partially refunded order keeps
 * total - sum(all its refunds), unclamped (the server rule), when refunds[] is present; without
 * refunds[] (older backend) a partial keeps max(total - refundedAmount, 0) and a refunded one 0.
 */
export const stillSoldMoney = (o: Pick<Order, 'status' | 'total' | 'refundedAmount' | 'refunds'>): number => {
  if (o.status === 'completed') return o.total
  if (o.refunds) return o.total - o.refunds.reduce((sum, r) => sum + r.amount, 0)
  return o.status === 'partially_refunded' ? Math.max(o.total - (o.refundedAmount ?? 0), 0) : 0
}

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] || 0) + v
}

/** One payment line of an order: what was applied to the bill in a method. */
export interface MethodLine { method: string; amount: number }

/**
 * The order's payment lines: the server's tenders[] (applied amounts) when present and non-empty,
 * else one synthetic line (order method, total) for an older backend or a pre-C6 order.
 */
export function tenderLines(o: Pick<Order, 'tenders' | 'paymentMethod' | 'total'>): MethodLine[] {
  if (o.tenders && o.tenders.length > 0) return o.tenders.map((t) => ({ method: t.method, amount: t.amount }))
  return [{ method: o.paymentMethod, amount: o.total }]
}

/** One (order, method) row: the sale lines in a method and the refund money paid out in it. */
export interface MethodRow { method: string; gross: number; paidOut: number; hasLine: boolean }

/** Refund money paid out per method over ALL the order's refund rows (the sale-basis net). */
function paidOutByMethod(o: Pick<Order, 'status' | 'total' | 'refundedAmount' | 'refunds' | 'paymentMethod'>): Map<string, number> {
  const out = new Map<string, number>()
  const put = (m: string, v: number) => out.set(m, (out.get(m) ?? 0) + v)
  if (o.refunds) {
    for (const r of o.refunds) put(r.paymentMethod || o.paymentMethod, r.amount)
    return out
  }
  // Older backend without refunds[]: whatever is no longer sold was paid back in the order method.
  const gone = o.total - stillSoldMoney(o)
  if (gone !== 0) put(o.paymentMethod, gone)
  return out
}

/**
 * The server's `sbl` rows for one order: its payment lines unioned with its refund rows per
 * method, so a refund paid out in a method the sale did not use still nets that method negative
 * and the per-method maps keep adding up to the order. hasLine marks methods that had a line.
 */
export function methodRows(o: Pick<Order, 'status' | 'total' | 'refundedAmount' | 'refunds' | 'paymentMethod' | 'tenders'>): MethodRow[] {
  const rows = new Map<string, MethodRow>()
  const row = (m: string): MethodRow => {
    const r = rows.get(m) ?? { method: m, gross: 0, paidOut: 0, hasLine: false }
    rows.set(m, r)
    return r
  }
  for (const l of tenderLines(o)) {
    const r = row(l.method)
    r.gross += l.amount
    r.hasLine = true
  }
  for (const [m, v] of paidOutByMethod(o)) row(m).paidOut += v
  return [...rows.values()]
}

/** Per-method net money of one order (lines minus refunds paid out), one entry per method row. */
export const methodNetRows = (o: Parameters<typeof methodRows>[0]): { method: string; net: number }[] =>
  methodRows(o).map((r) => ({ method: r.method, net: r.gross - r.paidOut }))

const norm = (m: string): string => m.trim().toLowerCase()
const SPLIT = 'split'

/** The D-66 payment-method rule of the server summary: none, the whole-order `split` value, or one method. */
type MethodRule = { kind: 'none' } | { kind: 'split' } | { kind: 'method'; method: string }

function methodRule(paymentMethod?: string): MethodRule {
  const m = norm(paymentMethod ?? '')
  if (m === '') return { kind: 'none' }
  return m === SPLIT ? { kind: 'split' } : { kind: 'method', method: m }
}

/** Refund payouts of an order inside the window, limited to a method under a method rule. */
function refundParts(o: Order, win: RefundWindow | undefined, rule: MethodRule): MethodLine[] {
  const slices = refundSlices(o)
  const fits = (m: string) => rule.kind !== 'method' || norm(m) === rule.method
  if (!slices) {
    return fits(o.paymentMethod) ? [{ method: o.paymentMethod, amount: refundedMoney(o) }] : []
  }
  return slices.filter((s) => inWindow(s.day, win) && fits(s.method)).map((s) => ({ method: s.method, amount: s.amount }))
}

/**
 * Client-side reference for the server's /reports/summary aggregation (A27), the parity oracle in
 * tests; the UI reads the server summary. Pass the rows of the SALE-basis list (`saleRows`) and of
 * the `dateBasis=refund` list (`refundRows`) for the same filter. Cancelled is never money.
 * net = gross - refunds, never revenue - refunds: a refunded sale is already missing from revenue.
 * C4a: a partially_refunded sale is a sale (counted in gross and completedCount); a refunded or
 * partially refunded sale keeps total - sum(its refunds) in revenue. Refunds sum the order's refunds[]
 * rows inside `win` (the server only sums in-window refund rows), falling back to refundedAmount ??
 * total when refunds[] is absent.
 *
 * C6a: the by-method maps are per (order, method) row, like the server: gross sums tenders[]
 * (else the order method, total), refunds are keyed by each refund row's payout method.
 * `paymentMethod` mirrors the server's D-66 filter rule: money is limited to that method (sales =
 * its lines, refunds = rows paid out in it, counts = orders with a line / refund in it); the
 * `split` value keeps whole-order money of orders whose paymentMethod is split. topProducts is
 * not limited (not computed here). Limit: `refundRows` is the filtered order LIST, so a refund
 * paid out in a method on an order with no line in it is invisible to this oracle.
 */
export function reportTotals(
  saleRows: readonly Order[], refundRows: readonly Order[], win?: RefundWindow, paymentMethod?: string,
): ReportTotals {
  const rule = methodRule(paymentMethod)
  const t: ReportTotals = {
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  }
  const isSplit = (o: Order) => norm(o.paymentMethod) === SPLIT
  for (const o of saleRows) {
    if (o.status !== 'completed' && o.status !== 'partially_refunded' && o.status !== 'refunded') continue
    if (rule.kind === 'split' && !isSplit(o)) continue
    let rows = methodRows(o)
    if (rule.kind === 'method') rows = rows.filter((r) => r.hasLine && norm(r.method) === rule.method)
    if (rows.length === 0) continue
    const limited = rule.kind === 'method'
    t.gross += limited ? rows.reduce((s, r) => s + r.gross, 0) : o.total
    t.grossCount += 1
    for (const r of rows) if (r.hasLine) add(t.grossByPay, r.method, r.gross)
    const sold = limited ? rows.reduce((s, r) => s + r.gross - r.paidOut, 0) : stillSoldMoney(o)
    const isSale = o.status === 'completed' || o.status === 'partially_refunded'
    if (isSale) t.completedCount += 1
    if (isSale || sold !== 0) t.revenue += sold
    for (const r of rows) if (isSale || r.gross - r.paidOut !== 0) add(t.byPay, r.method, r.gross - r.paidOut)
  }
  for (const o of refundRows) {
    if (!isRefundedStatus(o.status)) continue
    if (rule.kind === 'split' && !isSplit(o)) continue
    const parts = refundParts(o, win, rule)
    if (parts.length === 0) continue
    t.refundedCount += 1
    for (const p of parts) {
      t.refunds += p.amount
      add(t.refundsByPay, p.method, p.amount)
    }
  }
  t.net = t.gross - t.refunds
  return t
}
