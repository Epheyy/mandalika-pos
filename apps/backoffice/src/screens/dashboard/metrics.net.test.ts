import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import {
  buildTrend,
  delta,
  netKpis,
  netPaymentBreakdown,
  refundBusinessDayOf,
  refundSideOrNull,
  salesIn,
  refundsIn,
  type Interval,
} from './metrics'
import { reportTotals } from '../reports/reportTotals'

type BD = Order['businessDate']
const order = (over: Partial<Order>): Order =>
  ({
    id: 'o', orderNumber: 'N', outletId: 'x', cashierId: 'c', cashierName: 'C', items: [], subtotal: 0, discountAmount: 0,
    taxAmount: 0, total: 100, paymentMethod: 'cash', amountPaid: 100, change: 0, status: 'completed',
    createdAt: '2026-03-10T05:00:00Z', ...over,
  }) as Order

const day = (d: number): Interval => ({ start: new Date(2026, 2, d, 0, 0, 0), end: new Date(2026, 2, d, 23, 59, 59) })
const span = (a: number, b: number): Interval => ({ start: day(a).start, end: day(b).end })

// Golden example (plan section 5): sale 100 cash on D1 (03-10), refunded on D3 (03-12).
const sale = order({
  id: 's', status: 'refunded', total: 100, businessDate: '2026-03-10' as BD, refundBusinessDate: '2026-03-12',
  createdAt: new Date(2026, 2, 10, 10, 0).toISOString(), refundedAt: new Date(2026, 2, 12, 14, 30).toISOString(),
} as Partial<Order>)

describe('netKpis (D1/D3 golden)', () => {
  const saleRows = [sale]
  const refundRows = [sale]

  it.each([
    ['D1', day(10), 100, 0, 100],
    ['D2', day(11), 0, 0, 0],
    ['D3', day(12), 0, 100, -100],
    ['D1-D3', span(10, 12), 100, 100, 0],
  ] as const)('%s: gross/refund/net', (_n, iv, gross, refunds, net) => {
    const k = netKpis(saleRows, refundRows, iv)
    expect([k.gross, k.refunds, k.net]).toEqual([gross, refunds, net])
  })

  it('agrees with reportTotals on the interval-filtered rows for every window (wiring check; golden table above is the proof)', () => {
    for (const iv of [day(10), day(11), day(12), span(10, 12)]) {
      const t = reportTotals(salesIn(saleRows, iv), refundsIn(refundRows, iv))
      const k = netKpis(saleRows, refundRows, iv)
      expect(k.net).toBe(t.net)
      expect(k.gross).toBe(t.gross)
      expect(k.refunds).toBe(t.refunds)
    }
  })

  it('does not subtract a refund twice: a still-completed sale is not refunded', () => {
    const done = order({ id: 'd', total: 40, businessDate: '2026-03-10' as BD })
    const k = netKpis([sale, done], [sale], span(10, 12))
    expect(k.net).toBe(40)
    expect(k.grossCount).toBe(2)
    expect(k.refundedCount).toBe(1)
  })

  it('ignores cancelled rows and non-refunded rows on the refund side', () => {
    const cancelled = order({ id: 'c', status: 'cancelled', total: 999, businessDate: '2026-03-10' as BD })
    expect(netKpis([cancelled], [cancelled], day(10)).net).toBe(0)
  })

  it('falls back to the local day of refundedAt / createdAt when business dates are absent', () => {
    const legacy = order({
      status: 'refunded', total: 70,
      createdAt: new Date(2026, 2, 10, 9).toISOString(), refundedAt: new Date(2026, 2, 12, 9).toISOString(),
    })
    expect(refundBusinessDayOf(legacy)).toBe('2026-03-12')
    expect(netKpis([legacy], [legacy], day(10)).net).toBe(70)
    expect(netKpis([legacy], [legacy], day(12)).net).toBe(-70)
  })
})

describe('refundSideOrNull (old-backend safety)', () => {
  it('accepts refunded rows that carry refundBusinessDate (null allowed)', () => {
    expect(refundSideOrNull([sale])).toEqual([sale])
    expect(refundSideOrNull([])).toEqual([])
    const unset = { ...sale, refundBusinessDate: null } as unknown as Order
    expect(refundSideOrNull([unset])).toEqual([unset])
  })
  it('rejects a response that ignored dateBasis (non-refunded rows)', () => {
    expect(refundSideOrNull([order({ status: 'completed' })])).toBeNull()
  })
  it('rejects a response from a backend without refundBusinessDate', () => {
    const old = { ...sale } as Partial<Order>
    delete (old as { refundBusinessDate?: unknown }).refundBusinessDate
    expect(refundSideOrNull([old as Order])).toBeNull()
  })
})

describe('buildTrend with refunds', () => {
  const now = new Date(2026, 2, 12, 18)
  it('daily: sale on D1, refund on D3 -> +100, 0, -100', () => {
    const pts = buildTrend(salesIn([sale], span(10, 12)), '7d', now, refundsIn([sale], span(10, 12)))
    const last3 = pts.slice(-3).map((p) => p.revenue)
    expect(last3).toEqual([100, 0, -100])
  })
  it('hourly today buckets the refund by the local hour of refundedAt (negative value)', () => {
    const pts = buildTrend([], 'today', now, [sale])
    expect(pts[14].revenue).toBe(-100)
    expect(pts[10].revenue).toBe(0)
  })
  it('monthly (all) nets within the month', () => {
    const pts = buildTrend([sale], 'all', now, [sale])
    expect(pts.map((p) => p.revenue)).toEqual([0])
  })
  it('without refunds behaves as before', () => {
    expect(buildTrend([order({ businessDate: '2026-03-12' as BD, total: 5 })], '7d', now).pop()?.revenue).toBe(5)
  })
})

describe('netPaymentBreakdown', () => {
  it('is gross minus refunds per method, in the window', () => {
    const qris = order({ id: 'q', paymentMethod: 'qris', total: 250, businessDate: '2026-03-12' as BD })
    const rows = netPaymentBreakdown([sale, qris], [sale], day(12))
    expect(rows.map((r) => [r.method, r.amount])).toEqual([['qris', 250], ['cash', -100]])
  })
})

describe('delta', () => {
  it('rise from a negative previous net is positive (-100 -> -50 is +50%)', () => {
    expect(delta(-50, -100)).toBe(50)
  })
  it('fall further below a negative previous net is negative (-100 -> -150 is -50%)', () => {
    expect(delta(-150, -100)).toBe(-50)
  })
  it('crossing from negative to positive is positive', () => {
    expect(delta(100, -100)).toBe(200)
  })
  it('is null when prev is 0 or unavailable', () => {
    expect(delta(10, 0)).toBeNull()
    expect(delta(10, null)).toBeNull()
  })
  it('keeps the normal positive-prev behaviour', () => {
    expect(delta(150, 100)).toBe(50)
  })
})

describe('partially refunded orders (C4a)', () => {
  const partial = order({
    id: 'p', status: 'partially_refunded', total: 100, businessDate: '2026-03-10' as BD,
    refundedAmount: 40,
    refunds: [{ id: 'r1', seq: 1, scope: 'partial', amount: 40, computedAmount: 40, paymentMethod: 'cash', reason: 'x', refundedAt: new Date(2026, 2, 12, 14, 30).toISOString(), refundBusinessDate: '2026-03-12', items: [] }],
    createdAt: new Date(2026, 2, 10, 10, 0).toISOString(),
  } as Partial<Order>)

  it('is a sale on its sale day and a refund of refundedAmount on the refund day', () => {
    expect(netKpis([partial], [partial], day(10))).toMatchObject({ gross: 100, refunds: 0, net: 100 })
    expect(netKpis([partial], [partial], day(12))).toMatchObject({ gross: 0, refunds: 40, refundedCount: 1, net: -40 })
  })

  it('refundBusinessDayOf falls back to the latest refunds[] entry', () => {
    expect(refundBusinessDayOf(partial)).toBe('2026-03-12')
  })

  it('refundSideOrNull accepts partially refunded rows', () => {
    expect(refundSideOrNull([partial])).toEqual([partial])
  })

  it('without refundedAmount a refunded row still subtracts its total', () => {
    expect(netKpis([sale], [sale], day(12)).refunds).toBe(100)
  })
})
