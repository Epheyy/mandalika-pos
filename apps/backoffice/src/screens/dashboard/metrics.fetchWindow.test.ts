import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { buildTrend, businessDayOf, completedIn, dashboardFetchWindow, periodInterval, prevInterval } from './metrics'
import { localDay } from '../../lib/businessDay'

const order = (over: Partial<Order>): Order =>
  ({
    id: 'o', orderNumber: 'N', outletId: 'x', cashierId: 'c', cashierName: 'C', items: [], subtotal: 0, discountAmount: 0,
    taxAmount: 0, total: 100, paymentMethod: 'cash', amountPaid: 100, change: 0, status: 'completed',
    createdAt: '2026-03-10T05:00:00Z', ...over,
  }) as Order

describe('businessDayOf', () => {
  it('prefers the server business date over the createdAt day', () => {
    expect(businessDayOf(order({ createdAt: '2026-03-10T17:30:00Z', businessDate: '2026-03-10' as Order['businessDate'] }))).toBe('2026-03-10')
  })
  it('falls back to the local day of createdAt', () => {
    const o = order({ createdAt: '2026-03-10T05:00:00Z' })
    expect(businessDayOf(o)).toBe(localDay(new Date('2026-03-10T05:00:00Z')))
  })
})

describe('dashboardFetchWindow', () => {
  const now = new Date('2026-03-10T05:00:00Z')

  it('leaves "all" unbounded', () => {
    expect(dashboardFetchWindow('all', now)).toEqual({})
  })

  it('today sends the local business day for the interval and the previous day, with no padding', () => {
    expect(dashboardFetchWindow('today', now)).toEqual({ dateFrom: localDay(prevInterval('today', now)!.start), dateTo: localDay(now) })
  })

  it.each(['today', '7d', '30d'] as const)('%s covers current and previous interval (superset)', (period) => {
    const w = dashboardFetchWindow(period, now)
    expect(w.dateFrom).toBe(localDay(prevInterval(period, now)!.start))
    expect(w.dateTo).toBe(localDay(periodInterval(period, now).end))
  })
})

describe('completedIn', () => {
  const now = new Date(2026, 2, 10, 12)
  it('counts a sale by its business day even when createdAt is on the next UTC day', () => {
    const iv = periodInterval('today', now)
    const late = order({ id: 'late', createdAt: '2030-01-01T00:00:00Z', businessDate: localDay(now) as Order['businessDate'] })
    const other = order({ id: 'other', businessDate: '2026-03-09' as Order['businessDate'] })
    expect(completedIn([late, other], iv).map((o) => o.id)).toEqual(['late'])
  })
  it('ignores cancelled and refunded orders', () => {
    const iv = periodInterval('today', now)
    const bd = localDay(now) as Order['businessDate']
    expect(completedIn([order({ status: 'refunded', businessDate: bd }), order({ status: 'cancelled', businessDate: bd })], iv)).toEqual([])
  })
})

describe('buildTrend', () => {
  it('buckets daily points by business day', () => {
    const now = new Date(2026, 2, 10, 12)
    const o = order({ createdAt: '2026-03-09T20:00:00Z', businessDate: '2026-03-10' as Order['businessDate'], total: 500 })
    const points = buildTrend([o], '7d', now)
    expect(points[points.length - 1].revenue).toBe(500)
  })
  it('keeps the hour of createdAt for the hourly "today" view', () => {
    const now = new Date(2026, 2, 10, 12)
    const created = new Date(2026, 2, 10, 14, 5)
    const points = buildTrend([order({ createdAt: created.toISOString(), total: 70 })], 'today', now)
    expect(points[14].revenue).toBe(70)
  })
})
