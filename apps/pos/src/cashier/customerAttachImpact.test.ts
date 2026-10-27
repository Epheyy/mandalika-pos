import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'
import { customerAttachImpact, customerAttachMessage } from './customerAttachImpact'

type Promotion = components['schemas']['Promotion']
type CartItem = components['schemas']['CartItem']

const line = (id: string, price: number, extra: Partial<CartItem> = {}): CartItem => ({ productId: id, productName: id, variantSize: 'M', price, quantity: 1, subtotal: price, ...extra })
const promo = (id: string, over: Partial<Promotion> = {}): Promotion => ({
  id, name: `Promo ${id}`, type: 'percentage', value: 10, isActive: true, createdAt: '', combinable: true, ...over,
})
const base = (over: Partial<CashierState> = {}): CashierState => ({ ...CASHIER_INITIAL_STATE, cart: [line('a', 100000)], ...over })
const customer = { id: 'c1', name: 'Ani', phone: '0811', points: 0, totalSpent: 0, visitCount: 0, createdAt: '' }

describe('customerAttachImpact', () => {
  it('is empty for a plain cart and a plain percentage promo', () => {
    expect(customerAttachImpact(base({ appliedPromotions: [promo('P')] }))).toEqual([])
  })

  it('names a promo giveaway by its promo and a loyalty reward by its product', () => {
    const state = base({
      cart: [line('a', 100000), line('gift', 0, { isReward: true, rewardPromotionId: 'BX' }), line('oud', 0, { isReward: true, rewardConditionId: 'rc1' })],
      appliedPromotions: [promo('BX', { name: 'Beli 2 Gratis 1', type: 'buy_x_get_y' })],
    })
    expect(customerAttachImpact(state)).toEqual(['Beli 2 Gratis 1', 'Hadiah oud'])
  })

  it('names an applied bundle (has a freed set) and a linked giveaway code', () => {
    const bundle = promo('B', { name: 'Paket Duo', type: 'bundle' })
    const state = base({
      appliedPromotions: [bundle],
      bundleFreed: { B: [] },
      appliedPromoCodes: [{
        code: 'GIFT', value: 0, type: 'buy_x_get_y', combinable: true,
        promotion: { id: 'X', type: 'buy_x_get_y', value: 0, isBOGO: false, bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: ['g'], getDiscountKind: 'percentage', getDiscountValue: 100 } },
      }],
    })
    expect(customerAttachImpact(state)).toEqual(['Paket Duo', 'Kode Promo GIFT'])
  })

  it('does not flag a same-set BXGY code (no physical effect)', () => {
    const state = base({
      appliedPromoCodes: [{ code: 'SAME', value: 0, type: 'buy_x_get_y', combinable: true, promotion: { id: 'X', type: 'buy_x_get_y', value: 0, isBOGO: false, bxgyConfig: { buyQuantity: 1, getQuantity: 1, buyProductIds: ['a'], getProductIds: [], getDiscountKind: 'percentage', getDiscountValue: 50 } } }],
    })
    expect(customerAttachImpact(state)).toEqual([])
  })

  it('reports redeemed points and de-duplicates names', () => {
    const state = base({
      cart: [line('g1', 0, { isReward: true, rewardPromotionId: 'BX' }), line('g2', 0, { isReward: true, rewardPromotionId: 'BX' })],
      appliedPromotions: [promo('BX', { name: 'Hadiah Duo', type: 'buy_x_get_y' })],
      pointsToRedeem: 50,
    })
    expect(customerAttachImpact(state)).toEqual(['Hadiah Duo', 'poin yang ditukar'])
  })

  it('agrees with the reducer: empty impact means SET_CUSTOMER keeps cart and promos', () => {
    const state = base({ appliedPromotions: [promo('P')] })
    expect(customerAttachImpact(state)).toEqual([])
    const next = cashierReducer(state, { type: 'SET_CUSTOMER', customer })
    expect(next.cart).toEqual(state.cart)
    expect(next.appliedPromotions).toEqual(state.appliedPromotions)
  })

  it('agrees with the reducer: a non-empty impact really loses reward lines', () => {
    const state = base({ cart: [line('a', 100000), line('gift', 0, { isReward: true, rewardPromotionId: 'BX' })], appliedPromotions: [promo('BX', { type: 'buy_x_get_y' })] })
    expect(customerAttachImpact(state).length).toBeGreaterThan(0)
    expect(cashierReducer(state, { type: 'SET_CUSTOMER', customer }).cart.some((c) => c.isReward)).toBe(false)
  })
})

describe('customerAttachMessage', () => {
  it('joins names and varies the verb', () => {
    expect(customerAttachMessage(['A'], 'attach')).toBe('Menambahkan pelanggan akan menghapus A. Lanjutkan?')
    expect(customerAttachMessage(['A', 'B', 'C'], 'replace')).toBe('Mengganti pelanggan akan menghapus A, B dan C. Lanjutkan?')
    expect(customerAttachMessage(['A', 'B'], 'release')).toBe('Melepas pelanggan akan menghapus A dan B. Lanjutkan?')
  })
})
