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
    const s = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed, applications: 1 })
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
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed, applications: 1 })
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
    const s = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed, applications: 1 })
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
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed, applications: 1 })
    const removed = cashierReducer(applied, { type: 'REMOVE_BUNDLE', promotionId: 'bundle1', freed: partialFreed })
    expect(removed.cart.filter((c) => c.isReward)).toHaveLength(0)
    const atom = removed.cart.find((c) => c.productId === 'atom')
    expect(atom?.quantity).toBe(2)
    expect(atom?.subtotal).toBe(450000)
  })
})

describe('cashierReducer bundle restore on generic strip paths (stock leak fix)', () => {
  // owner combo: 110ml anchor stays paid; atom + 2ml are MOVED paid→reward @0.
  const bundlePromo = { id: 'bundle1', name: 'Combo', type: 'bundle', value: 0, isActive: true, createdAt: '' } as any
  const buildCart = (): CartItem[] => [
    paidLine('p110', 575000),
    paidLine('atom', 225000),
    paidLine('p2ml', 1),
  ]
  const freed: BundleFreed[] = [
    { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    { productId: 'p2ml', variantSize: 'M', productName: 'p2ml', fullPrice: 1, net: 0, quantity: 1 },
  ]
  const applyBundle = () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: buildCart() }
    return cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed, applications: 1 })
  }

  it('APPLY_BUNDLE records the freed set in bundleFreed keyed by promotion id', () => {
    const s = applyBundle()
    expect(s.bundleFreed['bundle1']).toBeDefined()
    expect(s.bundleFreed['bundle1']).toHaveLength(2)
  })

  it('SET_CUSTOMER restores freed bundle units to paid (freed units do not vanish)', () => {
    const s = cashierReducer(applyBundle(), {
      type: 'SET_CUSTOMER',
      customer: { id: 'c1', name: 'Budi' } as never,
    })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(ownedQty(s.cart, 'p110', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'p2ml', 'M')).toBe(1)
    expect(s.cart.find((c) => c.productId === 'atom')?.price).toBe(225000)
    expect(s.selectedCustomer?.id).toBe('c1')
    expect(s.bundleFreed).toEqual({})
  })

  it('REMOVE_PROMOTION(bundle) restores freed units to paid and clears its bundleFreed', () => {
    const s = cashierReducer(applyBundle(), { type: 'REMOVE_PROMOTION', id: 'bundle1' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(s.cart.find((c) => c.productId === 'atom')?.price).toBe(225000)
    expect(s.appliedPromotions.map((p) => p.id)).not.toContain('bundle1')
    expect(s.bundleFreed['bundle1']).toBeUndefined()
  })

  it('CLEAR_PROMOTIONS restores freed units, empties promotions, clears bundleFreed', () => {
    const s = cashierReducer(applyBundle(), { type: 'CLEAR_PROMOTIONS' })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'p2ml', 'M')).toBe(1)
    expect(s.appliedPromotions).toEqual([])
    expect(s.bundleFreed).toEqual({})
  })

  it('APPLY_PROMOTION toggle-off of a bundle restores freed units to paid', () => {
    const s = cashierReducer(applyBundle(), { type: 'APPLY_PROMOTION', promotion: bundlePromo })
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(s.appliedPromotions.map((p) => p.id)).not.toContain('bundle1')
    expect(s.bundleFreed['bundle1']).toBeUndefined()
  })

  // ── bundleApplications lock-step (applied-nApp bookkeeping) ────────────────
  // bundleApplications must be populated on APPLY_BUNDLE and cleared in lock-step
  // with bundleFreed on every strip/eviction path — a freed set must never
  // outlive its applied-nApp entry (or vice versa), else the reactive-removal
  // effect can't compare against a stale/missing applied count.
  it('APPLY_BUNDLE records the applied nApp in bundleApplications keyed by promotion id', () => {
    const s = applyBundle()
    expect(s.bundleApplications['bundle1']).toBe(1)
  })

  it('CLEAR_PROMOTIONS clears bundleApplications to {} in lock-step with bundleFreed', () => {
    const s = cashierReducer(applyBundle(), { type: 'CLEAR_PROMOTIONS' })
    expect(s.bundleFreed).toEqual({})
    expect(s.bundleApplications).toEqual({})
  })

  it('CART_REMOVE_ITEM eviction drops the id from BOTH bundleFreed and bundleApplications', () => {
    // Removing a FREED participant (atom) evicts the bundle → no stale entry may
    // survive in either map.
    const s = cashierReducer(applyBundle(), {
      type: 'CART_REMOVE_ITEM',
      productId: 'atom',
      variantSize: 'M',
    })
    expect(s.bundleFreed['bundle1']).toBeUndefined()
    expect(s.bundleApplications['bundle1']).toBeUndefined()
    expect(s.appliedPromotions.map((p) => p.id)).not.toContain('bundle1')
  })

  it('REMOVE_BUNDLE / REMOVE_PROMOTION clear the bundleApplications entry too', () => {
    const removed = cashierReducer(applyBundle(), {
      type: 'REMOVE_BUNDLE', promotionId: 'bundle1', freed,
    })
    expect(removed.bundleApplications['bundle1']).toBeUndefined()
    const removedP = cashierReducer(applyBundle(), { type: 'REMOVE_PROMOTION', id: 'bundle1' })
    expect(removedP.bundleApplications['bundle1']).toBeUndefined()
  })

  it('regression: SET_CUSTOMER strips a bxgy reward (added extra) but RESTORES the bundle (moved)', () => {
    const withBxgy = cashierReducer(applyBundle(), {
      type: 'CART_ADD_REWARD',
      item: promoReward('pX', 'M', 'bxgy1'),
    })
    const s = cashierReducer(withBxgy, {
      type: 'SET_CUSTOMER',
      customer: { id: 'c1', name: 'Budi' } as never,
    })
    // bxgy reward stripped without restore (it was an added freebie, not a moved unit)
    expect(s.cart.find((c) => c.productId === 'pX')).toBeUndefined()
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    // bundle restored to paid
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(s.cart.find((c) => c.productId === 'atom')?.price).toBe(225000)
  })

  it('does not double-restore: SET_CUSTOMER then CLEAR_PROMOTIONS keeps owned qty at 1', () => {
    const afterCust = cashierReducer(applyBundle(), {
      type: 'SET_CUSTOMER',
      customer: { id: 'c1', name: 'B' } as never,
    })
    const s = cashierReducer(afterCust, { type: 'CLEAR_PROMOTIONS' })
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(ownedQty(s.cart, 'p2ml', 'M')).toBe(1)
  })
})

describe('cashierReducer bundle reducer-edge consistency (item1 + item2)', () => {
  const bundlePromo = { id: 'bundle1', name: 'Combo', type: 'bundle', value: 0, combinable: true, isActive: true, createdAt: '' } as any
  const buildCart = (): CartItem[] => [
    paidLine('p110', 575000),
    paidLine('atom', 225000),
    paidLine('p2ml', 1),
  ]
  const freed: BundleFreed[] = [
    { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    { productId: 'p2ml', variantSize: 'M', productName: 'p2ml', fullPrice: 1, net: 0, quantity: 1 },
  ]
  const applyBundle = () =>
    cashierReducer({ ...CASHIER_INITIAL_STATE, cart: buildCart() }, {
      type: 'APPLY_BUNDLE', promotion: bundlePromo, freed, applications: 1,
    })

  // item1: an exclusive (non-combinable) promo replacing the applied set must
  // restore the evicted bundle's moved units + clear its bundleFreed — no ghost
  // Rp0 reward lines and no stale freed entry.
  it('item1: exclusive APPLY_PROMOTION eviction restores the bundle (no ghost reward lines, bundleFreed cleared)', () => {
    const excl = { id: 'x', name: 'X', type: 'percentage', value: 10, combinable: false, isActive: true, createdAt: '' } as any
    const s = cashierReducer(applyBundle(), { type: 'APPLY_PROMOTION', promotion: excl })
    // exclusive promo is now the only applied one
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['x'])
    // no bundle ghost reward lines linger
    expect(s.cart.filter((c) => c.isReward && c.rewardPromotionId)).toHaveLength(0)
    // freed units restored to paid at full price (stock conserved)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(s.cart.find((c) => c.productId === 'atom')?.price).toBe(225000)
    expect(ownedQty(s.cart, 'p2ml', 'M')).toBe(1)
    // stale freed entry cleared
    expect(s.bundleFreed).toEqual({})
  })

  it('item1: exclusive APPLY_PROMO_CODE eviction also restores the bundle (twin gap)', () => {
    const s = cashierReducer(applyBundle(), {
      type: 'APPLY_PROMO_CODE',
      code: { code: 'EXCL', type: 'percentage', value: 10 } as any,
      combinable: false,
    })
    expect(s.appliedPromotions).toEqual([])
    expect(s.appliedPromoCodes.map((c) => c.code)).toEqual(['EXCL'])
    expect(s.cart.filter((c) => c.isReward && c.rewardPromotionId)).toHaveLength(0)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
    expect(s.bundleFreed).toEqual({})
  })

  // item2: editing a paid line that participates in an applied bundle's freed set
  // must remove the bundle first (restore + clear entry) before applying the edit,
  // so no stale bundleFreed lingers and a later strip cannot over-restore.
  it('item2: CART_REMOVE_ITEM on a freed-set participant removes the bundle first (no stale entry)', () => {
    // extra atom so a paid atom line survives the bundle move (2 owned: 1 paid, 1 reward)
    const start = { ...CASHIER_INITIAL_STATE, cart: [paidLine('atom', 225000, 2), paidLine('p2ml', 1)] }
    const partialFreed: BundleFreed[] = [
      { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    ]
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed, applications: 1 })
    expect(applied.bundleFreed['bundle1']).toBeDefined()
    // cashier deletes the atom paid line
    const s = cashierReducer(applied, { type: 'CART_REMOVE_ITEM', productId: 'atom', variantSize: 'M' })
    // bundle removed → no stale entry, no reward lines, dropped from appliedPromotions
    expect(s.bundleFreed['bundle1']).toBeUndefined()
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    expect(s.appliedPromotions.map((p) => p.id)).not.toContain('bundle1')
    // both atom units gone (restore made 2 paid, then remove wiped the line)
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(0)
  })

  it('item2: CART_SET_QTY on a freed-set participant removes the bundle first, then sets qty', () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: [paidLine('atom', 225000, 2), paidLine('p2ml', 1)] }
    const partialFreed: BundleFreed[] = [
      { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    ]
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed, applications: 1 })
    const s = cashierReducer(applied, { type: 'CART_SET_QTY', productId: 'atom', variantSize: 'M', quantity: 5 })
    expect(s.bundleFreed['bundle1']).toBeUndefined()
    expect(s.cart.filter((c) => c.isReward)).toHaveLength(0)
    // restore merged to 2 paid, then set to 5
    const atom = s.cart.find((c) => c.productId === 'atom' && !c.isReward)
    expect(atom?.quantity).toBe(5)
    expect(atom?.price).toBe(225000)
  })

  it('item2: no over-restore — edit a freed participant then CLEAR_PROMOTIONS keeps owned qty sane', () => {
    const start = { ...CASHIER_INITIAL_STATE, cart: [paidLine('atom', 225000, 2), paidLine('p2ml', 1)] }
    const partialFreed: BundleFreed[] = [
      { productId: 'atom', variantSize: 'M', productName: 'atom', fullPrice: 225000, net: 0, quantity: 1 },
    ]
    const applied = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: bundlePromo, freed: partialFreed, applications: 1 })
    const edited = cashierReducer(applied, { type: 'CART_SET_QTY', productId: 'atom', variantSize: 'M', quantity: 1 })
    const s = cashierReducer(edited, { type: 'CLEAR_PROMOTIONS' })
    // bundle already gone at edit time → CLEAR cannot double-restore atom
    expect(ownedQty(s.cart, 'atom', 'M')).toBe(1)
  })

  it('item2: editing an UNRELATED paid line leaves the applied bundle intact', () => {
    const applied = applyBundle()
    const s = cashierReducer(applied, { type: 'CART_SET_QTY', productId: 'p110', variantSize: 'M', quantity: 3 })
    // p110 is the anchor (not in the freed set) → bundle stays applied here
    expect(s.bundleFreed['bundle1']).toBeDefined()
    expect(s.appliedPromotions.map((p) => p.id)).toContain('bundle1')
    expect(s.cart.find((c) => c.productId === 'p110' && !c.isReward)?.quantity).toBe(3)
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
