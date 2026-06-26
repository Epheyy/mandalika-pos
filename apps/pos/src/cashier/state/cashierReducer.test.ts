import { describe, it, expect } from 'vitest'
import { cashierReducer, CASHIER_INITIAL_STATE } from './cashierReducer'
import type { components } from '@mandalika/api'

const promo = (id: string, combinable: boolean) =>
  ({ id, name: id, type: 'percentage', value: 10, combinable }) as any

describe('promo stacking reducer', () => {
  it('appends combinable promotions', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('b', true) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('a non-combinable promotion replaces the set', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('x', false) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['x'])
    expect(s.appliedPromoCodes).toEqual([])
  })

  it('applying when a non-combinable is active replaces the set', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('x', false) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['a'])
  })

  it('re-applying the same promotion id toggles it off', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    expect(s.appliedPromotions).toEqual([])
  })

  it('REMOVE_PROMOTION removes by id', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo('a', true) })
    s = cashierReducer(s, { type: 'REMOVE_PROMOTION', id: 'a' })
    expect(s.appliedPromotions).toEqual([])
  })
})

type CartItem = components['schemas']['CartItem']

const paid = (productId: string, variantSize = 'M'): CartItem => ({
  productId, productName: 'P', variantSize, price: 10000, quantity: 1, subtotal: 10000,
})
const reward = (
  productId: string,
  conditionId: string,
): CartItem & { isReward: true; rewardConditionId: string } => ({
  productId, productName: 'Free', variantSize: 'M', price: 0, quantity: 1, subtotal: 0,
  isReward: true, rewardConditionId: conditionId,
})

describe('cashierReducer reward lines', () => {
  it('adds a reward line without merging into a paid line of the same product', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    expect(s.cart).toHaveLength(2)
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(1)
  })

  it('replaces the reward line when the same condition is re-picked', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pB', 'c1') })
    const rewards = s.cart.filter((c) => c.isReward)
    expect(rewards).toHaveLength(1)
    expect(rewards[0].productId).toBe('pB')
  })

  it('removes a reward line by condition', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_REMOVE_REWARD', rewardConditionId: 'c1' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })

  it('adding the same paid product twice still merges (reward guard does not break paid upsert)', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, { type: 'CART_ADD_ITEM', item: paid('pA') })
    expect(s.cart.filter((c) => !c.isReward)).toHaveLength(1)
    expect(s.cart[0].quantity).toBe(2)
  })

  it('drops reward lines when the customer changes', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'SET_CUSTOMER', customer: null })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })

  it('CART_REMOVE_ITEM removes the paid line but leaves a reward line of the same product', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_REMOVE_ITEM', productId: 'pA', variantSize: 'M' })
    expect(s.cart.filter((c) => !c.isReward)).toHaveLength(0)
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(1)
  })

  it('CART_SET_QTY does not touch a reward line of the same product/size', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_SET_QTY', productId: 'pA', variantSize: 'M', quantity: 5 })
    const rw = s.cart.filter((c) => c.isReward)
    expect(rw).toHaveLength(1)
    expect(rw[0].quantity).toBe(1)
  })

  it('keeps two reward lines for two different conditions; removing one leaves the other', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pB', 'c2') })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(2)
    s = cashierReducer(s, { type: 'CART_REMOVE_REWARD', rewardConditionId: 'c1' })
    const rw = s.cart.filter((c) => c.isReward)
    expect(rw).toHaveLength(1)
    expect(rw[0].rewardConditionId).toBe('c2')
  })

  it('drops reward lines when switching to a different (non-null) customer', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: reward('pA', 'c1') })
    // switch to a non-null customer
    s = cashierReducer(s, { type: 'SET_CUSTOMER', customer: { id: 'cust1', name: 'Budi' } as never })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })
})

const promoReward = (
  productId: string,
  variantSize: string,
  rewardPromotionId: string,
  price = 0,
): CartItem & { isReward: true; rewardPromotionId: string } => ({
  productId, productName: 'Free', variantSize, price, quantity: 1, subtotal: price,
  isReward: true, rewardPromotionId,
})

const promoRewardQty = (
  productId: string,
  variantSize: string,
  rewardPromotionId: string,
  quantity: number,
  price = 0,
): CartItem & { isReward: true; rewardPromotionId: string } => ({
  productId, productName: 'Free', variantSize, price, quantity, subtotal: price * quantity,
  isReward: true, rewardPromotionId,
})

describe('cashierReducer promo reward lines — multi-unit (qty-N aggregation)', () => {
  it('stores an aggregated qty-2 reward line with quantity 2 and subtotal net*2', () => {
    const NET = 5000
    const s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD',
      item: promoRewardQty('pA', 'M', 'promo1', 2, NET),
    })
    const rewards = s.cart.filter((c) => c.isReward && c.rewardPromotionId === 'promo1')
    expect(rewards).toHaveLength(1)
    expect(rewards[0].quantity).toBe(2)
    expect(rewards[0].subtotal).toBe(NET * 2)
  })

  it('summing reward units treats a qty-2 line as 2 units (not 1)', () => {
    const s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD',
      item: promoRewardQty('pA', 'M', 'promo1', 2),
    })
    const rewardUnits = s.cart
      .filter((c) => c.isReward && c.rewardPromotionId === 'promo1')
      .reduce((sum, c) => sum + c.quantity, 0)
    expect(rewardUnits).toBe(2)
  })

  it('re-adding the same (promo, product, variant) triple replaces the line regardless of quantity', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD',
      item: promoRewardQty('pA', 'M', 'promo1', 2, 5000),
    })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD',
      item: promoRewardQty('pA', 'M', 'promo1', 1, 0),
    })
    const rewards = s.cart.filter((c) => c.isReward && c.rewardPromotionId === 'promo1')
    expect(rewards).toHaveLength(1)
    expect(rewards[0].quantity).toBe(1)
    expect(rewards[0].subtotal).toBe(0)
  })

  it('CART_REMOVE_PROMO_REWARDS clears a qty-2 reward line entirely', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD',
      item: promoRewardQty('pA', 'M', 'promo1', 2),
    })
    s = cashierReducer(s, { type: 'CART_REMOVE_PROMO_REWARDS', rewardPromotionId: 'promo1' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })
})

describe('cashierReducer promo reward lines (buy_x_get_y separate-set)', () => {
  it('adds two reward lines for the same promo (different product/variant)', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD', item: promoReward('pA', 'S', 'promo1'),
    })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD', item: promoReward('pB', 'M', 'promo1'),
    })
    const rewards = s.cart.filter((c) => c.isReward && c.rewardPromotionId === 'promo1')
    expect(rewards).toHaveLength(2)
    expect(rewards.map((r) => r.productId).sort()).toEqual(['pA', 'pB'])
  })

  it('re-picking the same (promo, product, variant) triple replaces that line', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1', 5000),
    })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1', 0),
    })
    const rewards = s.cart.filter((c) => c.isReward && c.rewardPromotionId === 'promo1')
    expect(rewards).toHaveLength(1)
    expect(rewards[0].price).toBe(0)
  })

  it('paid CART_ADD_ITEM/CART_REMOVE_ITEM do not touch promo reward lines', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: paid('pA') })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1'),
    })
    s = cashierReducer(s, { type: 'CART_REMOVE_ITEM', productId: 'pA', variantSize: 'M' })
    expect(s.cart.filter((c) => !c.isReward)).toHaveLength(0)
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(1)
  })

  it('CART_REMOVE_PROMO_REWARDS removes all reward lines for the promo', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, {
      type: 'CART_ADD_REWARD', item: promoReward('pA', 'S', 'promo1'),
    })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD', item: promoReward('pB', 'M', 'promo1'),
    })
    s = cashierReducer(s, {
      type: 'CART_ADD_REWARD', item: promoReward('pC', 'L', 'promo2'),
    })
    s = cashierReducer(s, { type: 'CART_REMOVE_PROMO_REWARDS', rewardPromotionId: 'promo1' })
    const remaining = s.cart.filter((c) => c.isReward)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].rewardPromotionId).toBe('promo2')
  })
})
