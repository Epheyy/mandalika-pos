import { describe, expect, it } from 'vitest'
import { CASHIER_INITIAL_STATE, cashierReducer } from './state/cashierReducer'
import { heldOrderFromState, type HeldOrder } from './heldOrders'
import { planHeldRestore, type HeldRestoreEnv } from './heldRestore'

const NOW = new Date('2026-06-13T07:30:00Z')
const product = (id: string, sizes: Record<string, number>) => ({ id, name: `P-${id}`, isActive: true, variants: Object.entries(sizes).map(([size, price]) => ({ size, price, stock: 9 })) }) as never
const promo = (over: Record<string, unknown>) => ({ id: 'p1', name: 'Hemat', type: 'fixed', value: 1000, isActive: true, combinable: true, createdAt: '2026-01-01T00:00:00Z', ...over }) as never
const env = (over: Partial<HeldRestoreEnv> = {}): HeldRestoreEnv => ({
  products: [product('a', { S: 2000, M: 3000 })], promotions: [], discountCodes: [], ctx: { now: NOW, outletId: 'o1' }, ...over,
})
const held = (over: Partial<HeldOrder> = {}): HeldOrder => ({
  v: 1, id: 'h', name: 'n', heldAt: NOW.getTime(),
  lines: [{ productId: 'a', productName: 'P-a', variantSize: 'S', price: 1000, quantity: 2, subtotal: 2000 }],
  customer: null, salesman: null, notes: '', discount: { value: 0, type: 'fixed' }, surcharge: { value: 0, type: 'fixed' },
  stagedDiscountType: 'fixed', promotions: [], codes: [], rewardPicks: {}, loyaltyDropped: false, ...over,
})

describe('planHeldRestore', () => {
  it('starts with CART_CLEAR and composes only existing actions', () => {
    const plan = planHeldRestore(held({ notes: 'hadiah', salesman: { id: 's', name: 'Ani' } }), env())
    expect(plan.actions[0]).toEqual({ type: 'CART_CLEAR' })
    expect(plan.actions.map((a) => a.type)).toEqual(['CART_CLEAR', 'SET_SALESMAN', 'CART_ADD_ITEM', 'SET_ORDER_NOTES', 'SET_DISCOUNT_TYPE'])
  })
  it('re-prices lines from the current catalog and replaces whatever was in the cart', () => {
    const dirty = cashierReducer(CASHIER_INITIAL_STATE, { type: 'CART_ADD_ITEM', item: { productId: 'z', productName: 'Z', variantSize: 'S', price: 5, quantity: 1, subtotal: 5 } })
    const plan = planHeldRestore(held(), env())
    const after = plan.actions.reduce(cashierReducer, dirty)
    expect(after.cart).toEqual([{ productId: 'a', productName: 'P-a', variantSize: 'S', price: 2000, quantity: 2, subtotal: 4000 }])
    expect(after.cart).toEqual(plan.result.cart)
  })
  it('names a retired size instead of failing the whole restore', () => {
    const plan = planHeldRestore(held({ lines: [...held().lines, { productId: 'gone', productName: 'Lama', variantSize: 'S', price: 1, quantity: 1, subtotal: 1 }] }), env())
    expect(plan.result.cart).toHaveLength(1)
    expect(plan.notes).toContain('Tidak bisa dipulihkan: Lama (sudah tidak dijual)')
  })
  it('is lossless only when every line came back', () => {
    expect(planHeldRestore(held(), env()).lossless).toBe(true)
    const gone = held({ lines: [...held().lines, { productId: 'gone', productName: 'Lama', variantSize: 'S', price: 1, quantity: 1, subtotal: 1 }] })
    expect(planHeldRestore(gone, env()).lossless).toBe(false)
  })
  it('restores customer, notes and both manual adjustments with their own kinds', () => {
    const plan = planHeldRestore(held({
      customer: { id: 'c1', name: 'Sari', phone: '0811', points: 3 }, notes: 'bungkus',
      discount: { value: 10, type: 'percentage' }, surcharge: { value: 500, type: 'fixed' }, stagedDiscountType: 'percentage',
    }), env())
    const s = plan.result
    expect(s.selectedCustomer?.id).toBe('c1')
    expect(s.orderNotes).toBe('bungkus')
    expect([s.discountRunning, s.appliedDiscountType]).toEqual([10, 'percentage'])
    expect([s.surchargeRunning, s.appliedSurchargeType]).toEqual([500, 'fixed'])
    expect(s.discountType).toBe('percentage')
  })
  it('re-applies a live promotion through the apply action', () => {
    const plan = planHeldRestore(held({ promotions: [{ id: 'p1', name: 'Hemat' }] }), env({ promotions: [promo({})] }))
    expect(plan.actions.some((a) => a.type === 'APPLY_PROMOTION')).toBe(true)
    expect(plan.result.appliedPromotions.map((p) => p.id)).toEqual(['p1'])
    expect(plan.notes).toEqual([])
  })
  it('drops a promotion that is gone, with a per-item note, and keeps the rest', () => {
    const plan = planHeldRestore(held({ promotions: [{ id: 'gone', name: 'Lama' }, { id: 'p1', name: 'Hemat' }] }), env({ promotions: [promo({})] }))
    expect(plan.result.appliedPromotions.map((p) => p.id)).toEqual(['p1'])
    expect(plan.notes).toEqual(['Promo Lama tidak tersedia lagi'])
  })
  it('drops a promotion whose rule no longer holds (min purchase) through the confirm guard', () => {
    const plan = planHeldRestore(held({ promotions: [{ id: 'p1', name: 'Hemat' }] }), env({ promotions: [promo({ minPurchase: 999999 })] }))
    expect(plan.result.appliedPromotions).toEqual([])
    expect(plan.notes[0]).toMatch(/^Promo Hemat tidak berlaku lagi/)
  })
  it('re-validates a code and drops a dead one with a note', () => {
    const live = { id: 'c1', code: 'HEMAT', type: 'fixed', value: 500, usageCount: 0, isActive: true, createdAt: 'x' } as never
    const ok = planHeldRestore(held({ codes: ['HEMAT'] }), env({ discountCodes: [live] }))
    expect(ok.result.appliedPromoCodes.map((c) => c.code)).toEqual(['HEMAT'])
    const dead = planHeldRestore(held({ codes: ['HEMAT'] }), env())
    expect(dead.result.appliedPromoCodes).toEqual([])
    expect(dead.notes[0]).toMatch(/Kode Promo HEMAT tidak berlaku lagi/)
  })
  it('round-trips a snapshot taken from a real sale state', () => {
    const state = [
      { type: 'CART_ADD_ITEM', item: { productId: 'a', productName: 'P-a', variantSize: 'M', price: 3000, quantity: 1, subtotal: 3000 } },
      { type: 'SET_ORDER_NOTES', notes: 'n' },
    ].reduce((s, a) => cashierReducer(s, a as never), CASHIER_INITIAL_STATE)
    const plan = planHeldRestore(heldOrderFromState(state, { id: 'h', name: 'n', now: 1 }), env())
    expect(plan.result.cart).toEqual(state.cart)
    expect(plan.result.orderNotes).toBe('n')
  })
  it('tells the cashier loyalty has to be picked again', () => {
    expect(planHeldRestore(held({ loyaltyDropped: true }), env()).notes).toContain('Poin dan Hadiah loyalti perlu dipilih ulang')
  })
})
