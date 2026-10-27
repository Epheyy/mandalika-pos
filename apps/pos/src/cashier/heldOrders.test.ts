import { describe, expect, it } from 'vitest'
import type { KV } from '@mandalika/sync'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierState } from './state/cashierReducer'
import {
  defaultHeldName, heldOrderFromState, HeldOrdersStore, HELD_ORDERS_MAX, HELD_ORDERS_TTL_MS, heldOrdersKey, type HeldOrder,
} from './heldOrders'

const memKV = (): KV => {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), keys: () => [...m.keys()] } as KV
}
const NOW = Date.parse('2026-10-27T12:00:00Z')
const order = (id: string, heldAt = NOW): HeldOrder => ({
  v: 1, id, name: id, heldAt, lines: [], customer: null, salesman: null, notes: '',
  discount: { value: 0, type: 'fixed' }, surcharge: { value: 0, type: 'fixed' }, stagedDiscountType: 'fixed',
  promotions: [], codes: [], rewardPicks: {}, loyaltyDropped: false,
})
const line = (productId: string, size: string, quantity: number, price = 1000) => ({ productId, productName: `P-${productId}`, variantSize: size, price, quantity, subtotal: price * quantity })

describe('HeldOrdersStore', () => {
  it('lists newest first and round-trips through the kv', () => {
    const kv = memKV()
    const a = new HeldOrdersStore(kv, 'k', () => NOW)
    a.save(order('old', NOW - 1000))
    a.save(order('new', NOW))
    expect(new HeldOrdersStore(kv, 'k', () => NOW).list().map((o) => o.id)).toEqual(['new', 'old'])
  })
  it('refuses the 21st save and loses nothing', () => {
    const s = new HeldOrdersStore(memKV(), 'k', () => NOW)
    for (let i = 0; i < HELD_ORDERS_MAX; i++) expect(s.save(order(`o${i}`, NOW + i))).toEqual({ ok: true })
    expect(s.save(order('extra'))).toEqual({ ok: false, reason: 'full' })
    expect(s.count()).toBe(HELD_ORDERS_MAX)
    expect(s.list().some((o) => o.id === 'extra')).toBe(false)
  })
  it('removes one order by id', () => {
    const s = new HeldOrdersStore(memKV(), 'k', () => NOW)
    s.save(order('a'))
    s.save(order('b'))
    s.remove('a')
    expect(s.list().map((o) => o.id)).toEqual(['b'])
  })
  it('frees a slot after a delete', () => {
    const s = new HeldOrdersStore(memKV(), 'k', () => NOW)
    for (let i = 0; i < HELD_ORDERS_MAX; i++) s.save(order(`o${i}`, NOW + i))
    s.remove('o0')
    expect(s.save(order('again'))).toEqual({ ok: true })
  })
  it('drops expired and malformed entries on read', () => {
    const kv = memKV()
    kv.set('k', JSON.stringify([order('fresh'), order('stale', NOW - HELD_ORDERS_TTL_MS - 1), { v: 2, id: 'x' }, null, 'junk']))
    expect(new HeldOrdersStore(kv, 'k', () => NOW).list().map((o) => o.id)).toEqual(['fresh'])
  })
  it('survives garbage storage', () => {
    const kv = memKV()
    kv.set('k', '{not json')
    expect(new HeldOrdersStore(kv, 'k', () => NOW).list()).toEqual([])
  })
  it('refuses a save the storage swallowed (full or blocked) so the cart is not cleared for nothing', () => {
    const blocked = { get: () => null, set: () => undefined, remove: () => undefined, keys: () => [] } as unknown as KV
    expect(new HeldOrdersStore(blocked, 'k', () => NOW).save(order('a'))).toEqual({ ok: false, reason: 'write' })
  })
  it('keys per outlet', () => expect(heldOrdersKey('a')).not.toBe(heldOrdersKey('b')))
})

describe('defaultHeldName', () => {
  it('uses the customer name, else Pesanan HH:MM', () => {
    expect(defaultHeldName('  Sari ', new Date(2026, 9, 27, 9, 5))).toBe('Sari')
    expect(defaultHeldName(null, new Date(2026, 9, 27, 9, 5))).toBe('Pesanan 09:05')
    expect(defaultHeldName('   ', new Date(2026, 9, 27, 14, 30))).toBe('Pesanan 14:30')
  })
})

describe('heldOrderFromState', () => {
  const base = (over: Partial<CashierState>): CashierState => ({ ...CASHIER_INITIAL_STATE, ...over })
  it('keeps paid lines only and drops loyalty reward lines, flagging them', () => {
    const s = base({ cart: [line('a', 'S', 2), { ...line('g', 'S', 1, 0), isReward: true, rewardConditionId: 'c1' }] })
    const h = heldOrderFromState(s, { id: 'h', name: 'n', now: NOW })
    expect(h.lines.map((l) => l.productId)).toEqual(['a'])
    expect(h.loyaltyDropped).toBe(true)
  })
  it('puts the moved units of a bundle back on the paid line (stock conservation)', () => {
    const s = base({
      cart: [line('a', 'S', 1), { ...line('a', 'S', 1, 400), isReward: true, rewardPromotionId: 'b1' }],
      bundleFreed: { b1: [{ productId: 'a', productName: 'P-a', variantSize: 'S', quantity: 1, fullPrice: 1000, net: 400 } as never] },
    })
    const h = heldOrderFromState(s, { id: 'h', name: 'n', now: NOW })
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0].quantity).toBe(2)
    expect(h.rewardPicks).toEqual({})
  })
  it('records one giveaway pick per unit for a separate-set promo', () => {
    const s = base({ cart: [line('a', 'S', 2), { ...line('g', 'M', 2, 0), isReward: true, rewardPromotionId: 'p9' }] })
    expect(heldOrderFromState(s, { id: 'h', name: 'n', now: NOW }).rewardPicks.p9).toHaveLength(2)
  })
  it('keeps only the kept customer fields', () => {
    const customer = { id: 'c', name: 'Sari', phone: '0811', email: 'x@y', points: 5, totalSpent: 9, visitCount: 3, notes: 'secret', createdAt: 'z' } as never
    const h = heldOrderFromState(base({ cart: [line('a', 'S', 1)], selectedCustomer: customer }), { id: 'h', name: 'n', now: NOW })
    expect(h.customer).toEqual({ id: 'c', name: 'Sari', phone: '0811', points: 5 })
  })
  it('does not mutate the state it reads', () => {
    const s = base({ cart: [line('a', 'S', 1)] })
    const copy = JSON.stringify(s)
    heldOrderFromState(s, { id: 'h', name: 'n', now: NOW })
    expect(JSON.stringify(s)).toBe(copy)
    expect(cashierReducer(s, { type: 'CART_CLEAR' }).cart).toEqual([])
  })
})
