import { describe, expect, it } from 'vitest'
import type { KV } from '@mandalika/sync'
import type { components } from '@mandalika/api'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierAction, type CashierState } from './state/cashierReducer'
import { planHeldRestore } from './heldRestore'
import {
  decideHydration, OPEN_CART_TTL_MS, OpenCartStore, openCartFromState, openCartKey, restoreToast, revalidationDelta,
  type OpenCartDraft,
} from './openCartDraft'

type Product = components['schemas']['Product']

const memKV = (): KV => {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v), removeDurable: async (k) => void m.delete(k), keys: () => [...m.keys()],
  } as KV
}
const NOW = Date.parse('2026-11-05T09:00:00Z')
const line = (productId: string, size: string, quantity: number, price = 1000) => ({ productId, productName: `P-${productId}`, variantSize: size, price, quantity, subtotal: price * quantity })
const product = (id: string, size: string, price: number): Product => ({ id, name: `P-${id}`, variants: [{ size, price, stock: 5 }] } as unknown as Product)
const fold = (actions: CashierAction[], from: CashierState = CASHIER_INITIAL_STATE): CashierState => actions.reduce(cashierReducer, from)
const withCart = (): CashierState => fold([
  { type: 'CART_ADD_ITEM', item: line('a', '50ml', 2) },
  { type: 'CART_ADD_ITEM', item: line('b', '100ml', 1, 5000) },
  { type: 'SET_SALESMAN', salesman: { id: 's1', name: 'Sari' } },
  { type: 'SET_ORDER_NOTES', notes: 'bungkus' },
  { type: 'SET_DISCOUNT_TYPE', discountType: 'fixed' },
  { type: 'APPLY_DISCOUNT', value: 500 },
])
const src = (s: CashierState) => ({ ...s, isSuccessOpen: s.isSuccessOpen })
const draftOf = (s: CashierState, saleUuid = 'uuid-1'): OpenCartDraft => openCartFromState(src(s), { saleUuid, userId: 'u1', now: NOW })!

describe('openCartFromState', () => {
  it('captures lines, salesman, notes, manual discount and the sale uuid', () => {
    const d = draftOf(withCart())
    expect(d.saleUuid).toBe('uuid-1')
    expect(d.userId).toBe('u1')
    expect(d.held.lines.map((l) => [l.productId, l.quantity])).toEqual([['a', 2], ['b', 1]])
    expect(d.held.salesman).toEqual({ id: 's1', name: 'Sari' })
    expect(d.held.notes).toBe('bungkus')
    expect(d.held.discount).toEqual({ value: 500, type: 'fixed' })
  })
  it('is null for an empty cart, so Kosongkan / hold / new sale all remove the draft', () => {
    expect(openCartFromState(src(CASHIER_INITIAL_STATE), { saleUuid: 'x', userId: 'u1', now: NOW })).toBeNull()
    expect(openCartFromState(src(fold([{ type: 'CART_CLEAR' }], withCart())), { saleUuid: 'x', userId: 'u1', now: NOW })).toBeNull()
  })
  it('is null while the success view is open: ORDER_SUCCESS keeps the cart in state but the sale is queued', () => {
    const paid = fold([{ type: 'ORDER_SUCCESS', orderId: 'o', orderNumber: 'n' }], withCart())
    expect(paid.cart.length).toBeGreaterThan(0)
    expect(openCartFromState(src(paid), { saleUuid: 'x', userId: 'u1', now: NOW })).toBeNull()
  })
  it('is null once split payment lines exist: the split draft is the only owner of that sale', () => {
    const split = fold([{ type: 'SPLIT_START', orderUuid: 'u-s' }, { type: 'SPLIT_RESTORE', orderUuid: 'u-s', tenders: [{ method: 'qris', amount: 100 }] }], withCart())
    expect(split.tenders.length).toBeGreaterThan(0)
    expect(openCartFromState(src(split), { saleUuid: 'u-s', userId: 'u1', now: NOW })).toBeNull()
  })
  it('is null without a user', () => {
    expect(openCartFromState(src(withCart()), { saleUuid: 'x', userId: '', now: NOW })).toBeNull()
  })
})

describe('OpenCartStore', () => {
  it('round-trips through the kv', async () => {
    const kv = memKV()
    await new OpenCartStore(kv, 'k', () => NOW).save(draftOf(withCart()))
    expect(new OpenCartStore(kv, 'k', () => NOW).read()?.held.lines).toHaveLength(2)
  })
  it('reads a draft of another schema version as no draft', async () => {
    const kv = memKV()
    const s = new OpenCartStore(kv, 'k', () => NOW)
    await s.save({ ...draftOf(withCart()), v: 2 } as unknown as OpenCartDraft)
    expect(s.read()).toBeNull()
    await s.save({ ...draftOf(withCart()), held: { ...draftOf(withCart()).held, v: 2 } } as unknown as OpenCartDraft)
    expect(s.read()).toBeNull()
  })
  it('reads malformed and expired content as no draft', async () => {
    const kv = memKV()
    kv.set('k', '{not json')
    expect(new OpenCartStore(kv, 'k', () => NOW).read()).toBeNull()
    const s = new OpenCartStore(memKV(), 'k', () => NOW + OPEN_CART_TTL_MS + 1)
    await s.save(draftOf(withCart()))
    expect(s.read()).toBeNull()
  })
  it('clear removes it', async () => {
    const s = new OpenCartStore(memKV(), 'k', () => NOW)
    await s.save(draftOf(withCart()))
    await s.clear()
    expect(s.read()).toBeNull()
  })
  it('is keyed per outlet', () => {
    expect(openCartKey('o1')).not.toBe(openCartKey('o2'))
    expect(openCartKey('')).toBe('mandalika.pos.openCart.unbound')
  })
})

describe('decideHydration (no double submit, no inheritance)', () => {
  const base = { userId: 'u1', saleUuids: new Set<string>(), splitDraftOrderUuid: null as string | null }
  it('restores a fresh draft of the same cashier', () => {
    expect(decideHydration(draftOf(withCart()), base)).toBe('restore')
  })
  it('drops a draft whose sale uuid is already in the outbox or the receipts', () => {
    expect(decideHydration(draftOf(withCart(), 'uuid-1'), { ...base, saleUuids: new Set(['uuid-1']) })).toBe('drop')
  })
  it('drops a draft built by another cashier', () => {
    expect(decideHydration(draftOf(withCart()), { ...base, userId: 'u2' })).toBe('drop')
  })
  it('drops it when the split-payment draft of the same sale owns the cart (reload mid split checkout)', () => {
    expect(decideHydration(draftOf(withCart(), 'uuid-1'), { ...base, splitDraftOrderUuid: 'uuid-1' })).toBe('drop')
  })
  it('still restores a DIFFERENT sale rung up beside a waiting split draft', () => {
    expect(decideHydration(draftOf(withCart(), 'uuid-B'), { ...base, splitDraftOrderUuid: 'uuid-A' })).toBe('restore')
  })
  it('drops nothing-to-restore and signed-out cases', () => {
    expect(decideHydration(null, base)).toBe('drop')
    expect(decideHydration(draftOf(withCart()), { ...base, userId: null })).toBe('drop')
  })
})

describe('revalidation against the live catalogue', () => {
  const held = draftOf(withCart()).held
  it('drops lines whose product or variant is gone and re-prices the rest', () => {
    const products = [product('a', '50ml', 1500)]
    expect(revalidationDelta(held, products)).toEqual({ unavailable: 1, repriced: 1 })
    const plan = planHeldRestore(held, { products, promotions: [], discountCodes: [], ctx: { now: new Date(NOW), outletId: 'o1', timezone: undefined } })
    expect(plan.result.cart.map((c) => [c.productId, c.price, c.subtotal])).toEqual([['a', 1500, 3000]])
    expect(plan.result.selectedSalesman).toEqual({ id: 's1', name: 'Sari' })
    expect(plan.result.orderNotes).toBe('bungkus')
    expect(plan.result.discountRunning).toBe(500)
  })
  it('a retired size of an existing product also counts as unavailable', () => {
    expect(revalidationDelta(held, [product('a', '30ml', 1000), product('b', '100ml', 5000)]).unavailable).toBe(1)
  })
  it('toast names what changed, and is silent when nothing did', () => {
    expect(restoreToast({ unavailable: 1, repriced: 0 }, [])).toBe('Keranjang dipulihkan · 1 item tidak tersedia lagi')
    expect(restoreToast({ unavailable: 0, repriced: 2 }, [])).toBe('Keranjang dipulihkan · 2 harga diperbarui')
    expect(restoreToast({ unavailable: 0, repriced: 0 }, ['Promo X tidak tersedia lagi'])).toBe('Keranjang dipulihkan\nPromo X tidak tersedia lagi')
    expect(restoreToast({ unavailable: 0, repriced: 0 }, [])).toBeNull()
  })
})
