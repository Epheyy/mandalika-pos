import { describe, expect, it } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import {
  chipRewards, knownTier, localHistoryFor, pitchLines, planOne, planRepeat, recentCustomers, relativeDays, rewardsAvailableCount, tierForSpend,
} from './customerProfile'

const NOW = Date.parse('2026-10-27T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const product = (id: string, sizes: string[]) => ({ id, name: `P-${id}`, variants: sizes.map((size) => ({ size, price: 1000, stock: 5 })) }) as never

describe('tierForSpend / knownTier', () => {
  it('follows the backend thresholds', () => {
    expect([0, 499_999, 500_000, 2_000_000, 5_000_000].map(tierForSpend)).toEqual(['Member', 'Member', 'Silver', 'Gold', 'Platinum'])
  })
  it('shows no tier for a customer with no known spend', () => {
    expect(knownTier({ totalSpent: 0, visitCount: 0 })).toBeNull()
    expect(knownTier({ totalSpent: 2_500_000, visitCount: 4 })).toBe('Gold')
  })
})

describe('relativeDays', () => {
  it('speaks in days, weeks and months', () => {
    expect(relativeDays(daysAgo(0), NOW)).toBe('hari ini')
    expect(relativeDays(daysAgo(5), NOW)).toBe('5 hari lalu')
    expect(relativeDays(daysAgo(21), NOW)).toBe('3 minggu lalu')
    expect(relativeDays(daysAgo(130), NOW)).toBe('4 bulan lalu')
    expect(relativeDays('nope', NOW)).toBeNull()
    expect(relativeDays(null, NOW)).toBeNull()
  })
})

describe('pitchLines (Bahan obrolan)', () => {
  it('builds the last-purchase sentence with the usual interval in weeks', () => {
    expect(pitchLines({ lastItem: 'Rose 50ml', lastAt: daysAgo(21), usualIntervalDays: 30, neverTriedCategories: [] }, NOW)).toEqual([
      'Terakhir beli Rose 50ml (3 minggu lalu). Biasanya habis dalam ±4 minggu — tawarkan ukuran lebih besar.',
    ])
  })
  it('falls back to days under a week and omits the interval when unknown', () => {
    expect(pitchLines({ lastItem: 'Oud', lastAt: daysAgo(2), usualIntervalDays: 5, neverTriedCategories: [] }, NOW)[0]).toContain('±5 hari')
    expect(pitchLines({ lastItem: 'Oud', lastAt: daysAgo(2), usualIntervalDays: null, neverTriedCategories: [] }, NOW)).toEqual(['Terakhir beli Oud (2 hari lalu).'])
  })
  it('adds the never-tried line and says nothing for an empty pitch', () => {
    expect(pitchLines({ lastItem: null, lastAt: null, usualIntervalDays: null, neverTriedCategories: ['Woody', 'Citrus'] }, NOW)).toEqual(['Woody, Citrus belum pernah dicoba.'])
    expect(pitchLines({ lastItem: null, lastAt: null, usualIntervalDays: null, neverTriedCategories: [] }, NOW)).toEqual([])
  })
})

describe('planRepeat (Ulangi)', () => {
  const products = [product('a', ['50ml', '10ml']), product('b', ['30ml'])]
  it('merges lines per product and never repeats a reward line', () => {
    const plan = planRepeat(
      [
        { productId: 'a', name: 'A', size: '50ml', qty: 2, free: false },
        { productId: 'a', name: 'A', size: '10ml', qty: 1, free: false },
        { productId: 'b', name: 'B', size: '30ml', qty: 1, free: true },
      ],
      products,
    )
    expect(plan.adds).toHaveLength(1)
    expect(plan.adds[0].variantQtys).toEqual({ '50ml': 2, '10ml': 1 })
    expect(plan.skipped).toEqual([])
  })
  it('sums repeated sizes and skips a retired product or size by name', () => {
    const plan = planRepeat(
      [
        { productId: 'a', name: 'A', size: '50ml', qty: 1, free: false },
        { productId: 'a', name: 'A', size: '50ml', qty: 2, free: false },
        { productId: 'a', name: 'A', size: '100ml', qty: 1, free: false },
        { productId: 'gone', name: 'Gone', size: '50ml', qty: 1, free: false },
      ],
      products,
    )
    expect(plan.adds[0].variantQtys).toEqual({ '50ml': 3 })
    expect(plan.skipped).toEqual(['A', 'Gone'])
  })
  it('planOne adds a single unit', () => {
    expect(planOne({ productId: 'b', size: '30ml', name: 'B' }, products).adds[0].variantQtys).toEqual({ '30ml': 1 })
  })
})

describe('localHistoryFor', () => {
  const receipt = (over: Partial<LocalReceipt>): LocalReceipt => ({
    orderUuid: 'u', idempotencyKey: 'k', orderNumber: 'N-1', capturedAt: daysAgo(1), outletId: 'o', shiftId: null, paymentMethod: 'cash',
    quotedTotal: 100, receiptSnapshot: { total: 100, lines: [{ productId: 'a', variantSize: '50ml', name: 'A', qty: 2, unitPrice: 50, amount: 100 }, { productId: 'b', variantSize: '30ml', name: 'B', qty: 1, unitPrice: 0, amount: 0, isReward: true }] },
    state: 'queued', refundQueued: false, refunded: false, ...over,
  })
  it('drops refunded sales and flags reward lines as free', () => {
    const out = localHistoryFor([receipt({ orderUuid: 'x1' }), receipt({ orderUuid: 'x3', refunded: true })])
    expect(out.map((o) => o.id)).toEqual(['x1'])
    expect(out[0].lines.map((l) => [l.name, l.qty, l.free])).toEqual([['A', 2, false], ['B', 1, true]])
  })
  it('survives a missing or malformed snapshot', () => {
    expect(localHistoryFor([receipt({ receiptSnapshot: null })])[0].lines).toEqual([])
  })
  it('caps the list', () => {
    expect(localHistoryFor(Array.from({ length: 9 }, (_, i) => receipt({ orderUuid: `u${i}` })), 5)).toHaveLength(5)
  })
})

describe('recentCustomers', () => {
  const c = (id: string) => ({ id, name: id, phone: id, points: 0, totalSpent: 0, visitCount: 0, createdAt: '' }) as never
  it('de-duplicates, excludes matches and caps', () => {
    const out = recentCustomers([c('a'), c('b'), c('a'), c('c'), c('d')], [c('b')], 2)
    expect(out.map((x: { id: string }) => x.id)).toEqual(['a', 'c'])
  })
})

describe('chip states', () => {
  it('hides rewards when loyalty is off and locks them offline', () => {
    expect(chipRewards({ loyaltyEnabled: false, online: true, loading: false, count: 2 })).toEqual({ kind: 'hidden' })
    expect(chipRewards({ loyaltyEnabled: true, online: false, loading: false, count: 2 })).toEqual({ kind: 'offline' })
    expect(chipRewards({ loyaltyEnabled: true, online: true, loading: true, count: 0 })).toEqual({ kind: 'loading' })
    expect(chipRewards({ loyaltyEnabled: true, online: true, loading: false, count: 2 })).toEqual({ kind: 'count', n: 2 })
  })
  it('does not count a reward the cart already holds', () => {
    const rewards = [{ conditionId: 'c1' }, { conditionId: 'c2' }] as never
    expect(rewardsAvailableCount(rewards, [{ isReward: true, rewardConditionId: 'c1' }, { isReward: false }])).toBe(1)
  })
})
