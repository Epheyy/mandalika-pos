import { describe, it, expect } from 'vitest'
import { cashierReducer, CASHIER_INITIAL_STATE } from './cashierReducer'
import type { components } from '@mandalika/api'

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
