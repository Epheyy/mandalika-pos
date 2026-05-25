import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { applyCredits, retireByVersion, type PendingCredit } from './pendingCredits'

type Bundle = components['schemas']['SyncPullBundle']

function bundle(version: number, stock: number): Bundle {
  return {
    version,
    products: [{
      id: 'p1', name: 'Parfum', brand: 'M', categoryId: 'c1',
      variants: [{ size: '10ml', price: 1000, stock, sku: 'S1' }],
      isFeatured: false, isFavourite: false, isActive: true, createdAt: '2026-01-01T00:00:00Z',
    }],
    categories: [], bundles: [], customers: [], promotions: [],
    discountCodes: [], loyaltyConditions: [],
  } as unknown as Bundle
}
const credit = (key: string, qty: number, ackVersion: number | null = null): PendingCredit => ({
  idempotencyKey: key, ackVersion,
  lines: [{ productId: 'p1', variantSize: '10ml', qty }],
})

describe('applyCredits', () => {
  it('adds credited qty to matching variant stock', () => {
    const out = applyCredits(bundle(5, 10), [credit('k1', 3)])
    expect(out.products![0].variants[0].stock).toBe(13)
  })
  it('is a no-op with no credits (same reference)', () => {
    const b = bundle(5, 10)
    expect(applyCredits(b, [])).toBe(b)
  })
  it('does not mutate the input bundle', () => {
    const b = bundle(5, 10)
    applyCredits(b, [credit('k1', 3)])
    expect(b.products![0].variants[0].stock).toBe(10)
  })
})

describe('retireByVersion', () => {
  it('drops credits whose ackVersion <= snapshot version', () => {
    const kept = retireByVersion([credit('k1', 3, 7), credit('k2', 1, null)], 7)
    expect(kept.map((c) => c.idempotencyKey)).toEqual(['k2'])
  })
  it('keeps un-acked and future-version credits', () => {
    const kept = retireByVersion([credit('k1', 3, 9)], 7)
    expect(kept).toHaveLength(1)
  })
})
