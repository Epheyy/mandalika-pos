import { describe, expect, it } from 'vitest'
import { previewKey } from './useLoyaltyRewards'

describe('previewKey', () => {
  const paid = { productId: 'a', variantSize: '50ml', quantity: 1 }
  it('ignores reward lines so picking a reward never refetches', () => {
    const reward = { productId: 'g', variantSize: '10ml', quantity: 1, isReward: true }
    expect(previewKey([paid, reward], 1000)).toBe(previewKey([paid], 1000))
  })
  it('changes with a paid line, its quantity or the total', () => {
    const base = previewKey([paid], 1000)
    expect(previewKey([{ ...paid, quantity: 2 }], 1000)).not.toBe(base)
    expect(previewKey([paid, { ...paid, productId: 'b' }], 1000)).not.toBe(base)
    expect(previewKey([paid], 2000)).not.toBe(base)
  })
})
