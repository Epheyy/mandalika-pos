import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { reportTotals } from './reportTotals'

const tender = (method: string, amount: number) => ({ seq: 1, method, amount, tendered: amount, change: 0, synthetic: false })
const refund = (amount: number, paymentMethod?: string) => ({
  id: 'r', seq: 1, scope: 'partial', amount, computedAmount: amount, paymentMethod, reason: 'x',
  refundedAt: '2026-03-02T05:00:00Z', refundBusinessDate: '2026-03-02', items: [],
})
const mk = (o: Record<string, unknown>) => o as unknown as Order

// QRIS 751k + cash 500k on one bill.
const splitSale = (status: string, refunds?: unknown[]) =>
  mk({ status, total: 1251000, paymentMethod: 'split', tenders: [tender('qris', 751000), tender('cash', 500000)], refunds })

describe('reportTotals per-method money (C6a)', () => {
  it('sums tender lines for gross and refund payout methods for refunds', () => {
    const o = splitSale('partially_refunded', [refund(100000, 'cash')])
    const t = reportTotals([o], [o])
    expect(t.gross).toBe(1251000)
    expect(t.grossByPay).toEqual({ qris: 751000, cash: 500000 })
    expect(t.byPay).toEqual({ qris: 751000, cash: 400000 })
    expect(t.refundsByPay).toEqual({ cash: 100000 })
    expect(t.revenue).toBe(1151000)
    expect(t.net).toBe(1151000)
  })

  it('falls back to the order method when tenders are absent or empty', () => {
    for (const tenders of [undefined, []]) {
      const o = mk({ status: 'completed', total: 90, paymentMethod: 'qris', tenders })
      expect(reportTotals([o], []).grossByPay).toEqual({ qris: 90 })
      expect(reportTotals([o], []).byPay).toEqual({ qris: 90 })
    }
  })

  it('keys a refund by its own method, else by the order method', () => {
    const withMethod = mk({ status: 'refunded', total: 100, paymentMethod: 'qris', refunds: [refund(100, 'cash')] })
    const without = mk({ status: 'refunded', total: 100, paymentMethod: 'qris', refunds: [refund(100)] })
    expect(reportTotals([], [withMethod]).refundsByPay).toEqual({ cash: 100 })
    expect(reportTotals([], [without]).refundsByPay).toEqual({ qris: 100 })
  })

  it('a fully refunded split order keeps its per-method rows (+qris / -cash)', () => {
    const o = splitSale('refunded', [refund(1251000, 'cash')])
    const t = reportTotals([o], [o])
    expect(t.byPay).toEqual({ qris: 751000, cash: -751000 })
    expect(t.revenue).toBe(0)
    expect(t.grossByPay).toEqual({ qris: 751000, cash: 500000 })
    expect(t.refundsByPay).toEqual({ cash: 1251000 })
    expect(t.net).toBe(0)
  })
})

describe('reportTotals method filter (D-66)', () => {
  const o = splitSale('partially_refunded', [refund(100000, 'cash')])
  const cashOnly = mk({ status: 'completed', total: 40, paymentMethod: 'cash' })

  it('qris: its lines only, no cash refund counted', () => {
    const t = reportTotals([o, cashOnly], [o], undefined, 'qris')
    expect(t).toMatchObject({ gross: 751000, grossCount: 1, revenue: 751000, completedCount: 1, refunds: 0, refundedCount: 0, net: 751000 })
    expect(t.byPay).toEqual({ qris: 751000 })
    expect(t.grossByPay).toEqual({ qris: 751000 })
    expect(t.refundsByPay).toEqual({})
  })

  it('cash: its lines minus the cash refund, orders with a cash line', () => {
    const t = reportTotals([o, cashOnly], [o], undefined, ' CASH ')
    expect(t).toMatchObject({ gross: 500040, grossCount: 2, revenue: 400040, refunds: 100000, refundedCount: 1, net: 400040 })
    expect(t.byPay).toEqual({ cash: 400040 })
    expect(t.refundsByPay).toEqual({ cash: 100000 })
  })

  it('split: whole-order money of split orders only, maps unfiltered', () => {
    const t = reportTotals([o, cashOnly], [o], undefined, 'split')
    expect(t).toMatchObject({ gross: 1251000, grossCount: 1, revenue: 1151000, refunds: 100000, refundedCount: 1 })
    expect(t.byPay).toEqual({ qris: 751000, cash: 400000 })
  })

  it('a fully refunded split order under cash: all of it paid out in cash', () => {
    const full = splitSale('refunded', [refund(1251000, 'cash')])
    const t = reportTotals([full], [full], undefined, 'cash')
    expect(t).toMatchObject({ gross: 500000, revenue: -751000, refunds: 1251000, net: -751000 })
    expect(t.byPay).toEqual({ cash: -751000 })
  })

  it('legacy single-method orders: filter picks the order method; refunds without refunds[] follow it', () => {
    const q = mk({ status: 'refunded', total: 60, paymentMethod: 'qris' })
    expect(reportTotals([q], [q], undefined, 'cash')).toMatchObject({ gross: 0, refunds: 0 })
    expect(reportTotals([q], [q], undefined, 'qris')).toMatchObject({ gross: 60, refunds: 60, net: 0 })
  })
})
