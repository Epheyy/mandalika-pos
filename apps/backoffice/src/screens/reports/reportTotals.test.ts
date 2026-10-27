import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { reportTotals } from './reportTotals'

const order = (status: string, total: number, paymentMethod: string): Order =>
  ({ status, total, paymentMethod }) as unknown as Order

// Same shape as the A26 PostgreSQL fixture: cancelled never counts as money,
// payment methods group by the raw string (" QRIS" and "qris" stay separate).
it('totals completed money, refunds and payment breakdown', () => {
  const t = reportTotals(
    [
      order('completed', 16777217.37, ' QRIS'),
      order('completed', 16777219.11, 'qris'),
      order('completed', 12345.67, 'cash'),
      order('refunded', 5000.5, 'cash'),
      order('cancelled', 900, 'cash'),
    ],
    [order('refunded', 5000.5, 'cash')],
  )
  expect(t.revenue).toBeCloseTo(16777217.37 + 16777219.11 + 12345.67, 2)
  expect(t.completedCount).toBe(3)
  expect(t.gross).toBeCloseTo(16777217.37 + 16777219.11 + 12345.67 + 5000.5, 2)
  expect(t.grossCount).toBe(4)
  expect(t.refunds).toBe(5000.5)
  expect(t.refundedCount).toBe(1)
  expect(Object.keys(t.byPay).sort()).toEqual([' QRIS', 'cash', 'qris'])
  expect(t.byPay['cash']).toBe(12345.67)
  expect(t.grossByPay['cash']).toBeCloseTo(12345.67 + 5000.5, 2)
  expect(t.refundsByPay).toEqual({ cash: 5000.5 })
})

it('is all zero for empty lists', () => {
  expect(reportTotals([], [])).toEqual({
    gross: 0, grossCount: 0, revenue: 0, completedCount: 0, refunds: 0, refundedCount: 0, net: 0,
    byPay: {}, grossByPay: {}, refundsByPay: {},
  })
})

// A27 golden numbers: sale X Rp100 cash on D1, refunded on D3. The refund is recognised on the
// refund day; net = gross - refunds (a refunded sale is already missing from totalSales).
describe('refund-day recognition (A27)', () => {
  const sale = order('refunded', 100, 'cash') // sold D1, refunded D3
  it('D1 window: sale rows only', () => {
    const t = reportTotals([sale], [])
    expect(t).toMatchObject({ gross: 100, grossCount: 1, revenue: 0, refunds: 0, net: 100 })
    expect(t.grossByPay).toEqual({ cash: 100 })
    expect(t.refundsByPay).toEqual({})
  })
  it('D2 window: nothing', () => {
    expect(reportTotals([], [])).toMatchObject({ gross: 0, refunds: 0, net: 0 })
  })
  it('D3 window: refund rows only, net is negative', () => {
    const t = reportTotals([], [sale])
    expect(t).toMatchObject({ gross: 0, revenue: 0, refunds: 100, refundedCount: 1, net: -100 })
    expect(t.refundsByPay).toEqual({ cash: 100 })
  })
  it('D1-D3 window: nets to zero, never totalSales - refunds', () => {
    const t = reportTotals([sale], [sale])
    expect(t).toMatchObject({ gross: 100, revenue: 0, refunds: 100, net: 0 })
    expect(t.revenue - t.refunds).toBe(-100) // the double-subtraction trap
  })
  it('ignores cancelled rows on both sides', () => {
    expect(reportTotals([order('cancelled', 900, 'cash')], [order('cancelled', 900, 'cash')])).toMatchObject({ gross: 0, refunds: 0, net: 0 })
  })
})

// C4a: partially_refunded is a sale; refunds read refundedAmount and fall back to total when absent.
describe('reportTotals with partial refunds (C4a)', () => {
  const part = (total: number, refundedAmount: number | undefined, pay = 'cash') =>
    ({ status: 'partially_refunded', total, paymentMethod: pay, refundedAmount }) as unknown as Order

  it('counts a partially refunded sale in gross and net revenue, refunds by refundedAmount', () => {
    const p = part(100, 30)
    const t = reportTotals([order('completed', 50, 'cash'), p], [p])
    expect(t.gross).toBe(150)
    expect(t.grossCount).toBe(2)
    expect(t.revenue).toBe(120)
    expect(t.completedCount).toBe(2)
    expect(t.byPay).toEqual({ cash: 120 })
    expect(t.refunds).toBe(30)
    expect(t.refundedCount).toBe(1)
    expect(t.refundsByPay).toEqual({ cash: 30 })
    expect(t.net).toBe(120)
  })

  it('uses refundedAmount for a refunded row and falls back to total when absent', () => {
    const withAmt = { ...order('refunded', 100, 'cash'), refundedAmount: 80 } as Order
    expect(reportTotals([withAmt], [withAmt]).refunds).toBe(80)
    expect(reportTotals([order('refunded', 100, 'cash')], [order('refunded', 100, 'cash')]).refunds).toBe(100)
  })

  it('treats an absent refundedAmount on a partial row as nothing refunded from revenue', () => {
    const t = reportTotals([part(100, undefined)], [])
    expect(t.revenue).toBe(100)
  })
})

// F2: refund totals sum only the refunds[] rows inside the window; sale-side residual is
// total - sum(all refunds) when refunds[] is present, with the old logic as the fallback.
describe('reportTotals refund windows and residuals (C4a F2)', () => {
  const rf = (amount: number, day: string) => ({
    id: day, seq: 1, scope: 'partial', amount, computedAmount: amount, paymentMethod: 'cash', reason: 'x',
    refundedAt: `${day}T05:00:00Z`, refundBusinessDate: day, items: [],
  })
  const multi = {
    status: 'partially_refunded', total: 100, paymentMethod: 'cash', refundedAmount: 50,
    refunds: [rf(30, '2026-03-02'), rf(20, '2026-03-05')],
  } as unknown as Order

  it('sums only in-window refund rows (30 on D2, 20 on D5, window D2..D3 = 30)', () => {
    const t = reportTotals([multi], [multi], { from: '2026-03-02', to: '2026-03-03' })
    expect(t.refunds).toBe(30)
    expect(t.refundedCount).toBe(1)
    expect(t.refundsByPay).toEqual({ cash: 30 })
    expect(t.revenue).toBe(50)
  })

  it('skips an order with no refund row inside the window', () => {
    const t = reportTotals([multi], [multi], { from: '2026-03-03', to: '2026-03-04' })
    expect(t.refunds).toBe(0)
    expect(t.refundedCount).toBe(0)
  })

  it('without a window sums every refund row', () => {
    expect(reportTotals([multi], [multi]).refunds).toBe(50)
  })

  it('falls back to refundedAmount ?? total when refunds[] is absent, ignoring the window', () => {
    const legacyPartial = { status: 'partially_refunded', total: 100, paymentMethod: 'cash', refundedAmount: 40 } as unknown as Order
    const legacyFull = { status: 'refunded', total: 100, paymentMethod: 'cash' } as unknown as Order
    const w = { from: '2026-03-02', to: '2026-03-03' }
    expect(reportTotals([legacyPartial], [legacyPartial], w).refunds).toBe(40)
    expect(reportTotals([legacyFull], [legacyFull], w).refunds).toBe(100)
    expect(reportTotals([legacyFull], [], w).revenue).toBe(0)
    expect(reportTotals([legacyPartial], [], w).revenue).toBe(60)
  })

  it('keeps total - sum(refunds) as revenue for a refunded order whose refunds differ from total (100 total, 25+70)', () => {
    const o = {
      status: 'refunded', total: 100, paymentMethod: 'cash', refundedAmount: 95,
      refunds: [rf(25, '2026-03-02'), rf(70, '2026-03-03')],
    } as unknown as Order
    const t = reportTotals([o], [o])
    expect(t.revenue).toBe(5)
    expect(t.byPay).toEqual({ cash: 5 })
    expect(t.completedCount).toBe(0)
    expect(t.gross).toBe(100)
    expect(t.refunds).toBe(95)
    expect(t.net).toBe(5)
  })
})

it('keeps a {method: 0} byPay key for a Rp0 completed order (server parity)', () => {
  const t = reportTotals([order('completed', 0, 'cash')], [])
  expect(t.byPay).toEqual({ cash: 0 })
  expect(t.completedCount).toBe(1)
})
