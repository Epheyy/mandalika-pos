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

/** One refund row of an order placed on its refund business day. */
export interface RefundSlice { day: string; at: string | null; amount: number }

/**
 * The order's refund rows as slices, or null when the backend sent no refunds[] (older backend:
 * callers fall back to refundedAmount ?? total). The day is the row's refundBusinessDate, else the
 * browser-local day of refundedAt, mirroring the server's refund-basis day.
 */
export function refundSlices(o: Pick<Order, 'refunds'>): RefundSlice[] | null {
  if (!o.refunds) return null
  return o.refunds.map((r) => {
    let day = r.refundBusinessDate ?? ''
    if (!day && r.refundedAt) {
      try { day = localDay(parseISO(r.refundedAt)) } catch { day = '' }
    }
    return { day, at: r.refundedAt ?? null, amount: r.amount }
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

/**
 * Client-side reference for the server's /reports/summary aggregation (A27), the parity oracle in
 * tests; the UI reads the server summary. Pass the rows of the SALE-basis list (`saleRows`) and of
 * the `dateBasis=refund` list (`refundRows`) for the same filter. Cancelled is never money.
 * net = gross - refunds, never revenue - refunds: a refunded sale is already missing from revenue.
 * C4a: a partially_refunded sale is a sale (counted in gross and completedCount); a refunded or
 * partially refunded sale keeps total - sum(its refunds) in revenue. Refunds sum the order's refunds[]
 * rows inside `win` (the server only sums in-window refund rows), falling back to refundedAmount ??
 * total when refunds[] is absent.
 */
export function reportTotals(saleRows: readonly Order[], refundRows: readonly Order[], win?: RefundWindow): ReportTotals {
  const t: ReportTotals = {
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  }
  for (const o of saleRows) {
    if (o.status !== 'completed' && o.status !== 'partially_refunded' && o.status !== 'refunded') continue
    t.gross += o.total
    t.grossCount += 1
    add(t.grossByPay, o.paymentMethod, o.total)
    const sold = stillSoldMoney(o)
    if (o.status === 'completed' || o.status === 'partially_refunded') t.completedCount += 1
    if (sold !== 0) {
      t.revenue += sold
      add(t.byPay, o.paymentMethod, sold)
    }
  }
  for (const o of refundRows) {
    if (!isRefundedStatus(o.status)) continue
    if (!hasRefundIn(o, win)) continue
    const refunded = refundMoneyIn(o, win)
    t.refunds += refunded
    t.refundedCount += 1
    add(t.refundsByPay, o.paymentMethod, refunded)
  }
  t.net = t.gross - t.refunds
  return t
}
