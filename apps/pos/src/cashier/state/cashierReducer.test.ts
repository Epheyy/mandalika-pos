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

describe('cashierReducer reward lines cleared on promo removal (lingering-reward bug)', () => {
  const promo = { id: 'promo1', name: 'P', type: 'buy_x_get_y', value: 0, isActive: true, createdAt: '' } as any
  it('REMOVE_PROMOTION strips that promo reward lines', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1') })
    s = cashierReducer(s, { type: 'REMOVE_PROMOTION', id: 'promo1' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
  })
  it('CLEAR_PROMOTIONS strips all promo reward lines (keeps loyalty rewards)', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: promoReward('pB', 'M', 'promo2') })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: reward('pC', 'cond1') }) // loyalty reward (rewardConditionId)
    s = cashierReducer(s, { type: 'CLEAR_PROMOTIONS' })
    expect(s.cart.filter((c) => c.isReward && c.rewardPromotionId)).toHaveLength(0)
    expect(s.cart.filter((c) => c.isReward && c.rewardConditionId === 'cond1')).toHaveLength(1)
  })
  it('APPLY_PROMOTION toggle-off strips that promo reward lines', () => {
    let s = cashierReducer(CASHIER_INITIAL_STATE, { type: 'APPLY_PROMOTION', promotion: promo })
    s = cashierReducer(s, { type: 'CART_ADD_REWARD', item: promoReward('pA', 'M', 'promo1') })
    s = cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: promo })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(s.appliedPromotions).toHaveLength(0)
  })
})

// ── bundle apply/remove (stock-conserving) ──────────────────────────────────
type BundleFreed = {
  productId: string
  variantSize: string
  productName: string
  fullPrice: number
  net: number
  quantity: number
}
const bundlePromo = { id: 'bundle1', name: 'Combo', type: 'bundle', value: 0, isActive: true, createdAt: '' } as any

const paidLine = (
  productId: string,
  price: number,
  quantity = 1,
  variantSize = 'M',
): CartItem => ({ productId, productName: productId, variantSize, price, quantity, subtotal: price * quantity })

// owned-qty per (pid,size) across paid + reward lines
const ownedQty = (cart: CartItem[], productId: string, variantSize: string) =>
  cart
    .filter((c) => c.productId === productId && c.variantSize === variantSize)
    .reduce((s, c) => s + c.quantity, 0)

describe('cashierReducer APPLY_BUNDLE / REMOVE_BUNDLE (stock-conserving)', () => {
  // owner combo: 110ml 575000, atomizer 225000, 2ml 1 — bundle frees atom+2ml @0
  const buildCart = (): CartItem[] => [
    paidLine('p110', 575000),
    paidLine('atom', 225000),
    paidLine('p2ml', 1),
  ]
  const freed: BundleFreed[] = [
    { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    { productId: 'p2ml', variantSize: 'M', productName: 'p2ml', fullPrice: 1, net: 0, quantity: 1 },
  ]

  it('applying a bundle frees the cheapest units and conserves owned quantity', () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: buildCart() }
    const s = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed })
    // 110ml still a paid line at full price
    const p110 = s.cart.find((c) => c.productId === 'p110' && !c.isReward)
    expect(p110?.quantity).toBe(1)
    expect(p110?.price).toBe(575000)
    // atom + 2ml became reward lines @0, their paid lines gone
    expect(s.cart.filter((c) => c.productId === 'atom' && !c.isReward)).toHaveLength(0)
    const atomReward = s.cart.find((c) => c.productId === 'atom' && c.isReward)
    expect(atomReward?.rewardPromotionId).toBe('bundle1')
    expect(atomReward?.price).toBe(0)
    // stock-conservation invariant: paidQty + rewardQty == ownedQty (1 each)
    expect(ownedQty(s.cart, 'p110', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'p2ml', 'M')).toBe(1)
    // promotion registered
    expect(s.appliedPromotions.map((p) => p.id)).toContain('bundle1')
  })

  it('removing the bundle restores the freed units to paid and clears reward lines', () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: buildCart() }
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed })
    const removed = cashierReducer(applied, { type: 'REMOVE_BUNDLE', promotionId: 'bundle1', freed })
    // no reward lines remain
    expect(removed.cart.filter((c) => c.isReward)).toHaveLength(0)
    // three paid lines restored at full price
    const byId = Object.fromEntries(removed.cart.map((c) => [c.productId, c]))
    expect(byId['p110'].quantity).toBe(1)
    expect(byId['atom'].quantity).toBe(1)
    expect(byId['atom'].price).toBe(225000)
    expect(byId['p2ml'].quantity).toBe(1)
    expect(byId['p2ml'].price).toBe(1)
    // promotion removed
    expect(removed.appliedPromotions.map((p) => p.id)).not.toContain('bundle1')
    // invariant still holds after apply→remove
    expect(ownedQty(removed.cart, 'atom', 'M')).toBe(1)
  })

  it('partial anchor: only 1 of a 2-qty paid line is freed, the rest stays paid', () => {
    // 2 atomizers on one line; bundle frees 1 (partial net) → paid qty 2→1, reward qty 1
    const start = {
      ...CASHIER_INITIAL_STATE,
      cart: [paidLine('atom', 225000, 2)],
    }
    const partialFreed: BundleFreed[] = [
      { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 100000, quantity: 1 },
    ]
    const s = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed })
    const paidAtom = s.cart.find((c) => c.productId === 'atom' && !c.isReward)
    expect(paidAtom?.quantity).toBe(1)
    expect(paidAtom?.subtotal).toBe(225000)
    const rewardAtom = s.cart.find((c) => c.productId === 'atom' && c.isReward)
    expect(rewardAtom?.quantity).toBe(1)
    expect(rewardAtom?.price).toBe(100000)
    expect(rewardAtom?.subtotal).toBe(100000)
    // owned conserved: 1 paid + 1 reward == 2
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(2)
  })

  it('apply→remove round-trips a multi-qty line back to its exact pre-apply shape', () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: [paidLine('atom', 225000, 2)] }
    const partialFreed: BundleFreed[] = [
      { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    ]
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed })
    const removed = cashierReducer(applied, { type: 'REMOVE_BUNDLE', promotionId: 'bundle1', freed: partialFreed })
    expect(removed.cart.filter((c) => c.isReward)).toHaveLength(0)
    const atom = removed.cart.find((c) => c.productId === 'atom')
    expect(atom?.quantity).toBe(2)
    expect(atom?.subtotal).toBe(450000)
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
