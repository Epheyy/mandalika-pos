import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { promotionKeySetsOverlap, promotionKeyGroupsOverlap } from '@mandalika/types'
import { promotionKeyError } from './promotionKeyValidation'
import type { PromotionInput } from '@mandalika/api'

const vectors: { name: string; left: string[]; right: string[]; overlap: boolean }[] = JSON.parse(readFileSync(new URL('../../../../../backend/internal/promotionkeys/testdata/overlap.json', import.meta.url), 'utf8'))
it.each(vectors)('$name shared contract and real authoring guard', v => {
  expect(promotionKeySetsOverlap(v.left, v.right)).toBe(v.overlap)
  expect(promotionKeySetsOverlap(v.right, v.left)).toBe(v.overlap)
  expect(promotionKeyGroupsOverlap([v.left, v.right])).toBe(v.overlap)
  const form: PromotionInput = { name: 'test', type: 'bundle', value: 0, isActive: true,
    bundleConfig: { slots: [{ productKeys: v.left, quantity: 1 }, { productKeys: v.right, quantity: 1 }], bundlePrice: 50 } }
  expect(promotionKeyError(form) !== null).toBe(v.overlap)
  expect(promotionKeyError({ ...form, type: 'buy_x_get_y', bxgyConfig: { buyProductIds: v.left, getProductIds: v.right, buyQuantity: 1, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100 } }) !== null).toBe(v.overlap)
})
it('within-slot alternatives do not create cross-slot overlap', () => {
  expect(promotionKeyGroupsOverlap([['P', 'P|M'], ['Q']])).toBe(false)
})
