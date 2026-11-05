import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { components } from '@mandalika/api'
import type { KV } from '@mandalika/sync'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierAction, type CashierState } from './state/cashierReducer'
import { heldOrderFromState } from './heldOrders'
import { planHeldRestore } from './heldRestore'
import { OpenCartStore, decideHydration, openCartFromState } from './openCartDraft'
import { customerAttachImpact } from './customerAttachImpact'
import { autoReconcileFingerprint, autoRunAllowed, autoSetWouldChange, hasAutoPromotions, type AutoRunGates } from './autoPromoRun'
import { tieredOneLiner, autoPromptLabel } from './promoCopy'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const NOW = new Date('2026-09-20T05:00:00Z') // 12:00 WIB
const ctx = { now: NOW, outletId: 'outlet' }
const promo = (id: string, over: Partial<Promotion> = {}): Promotion =>
  ({ id, name: id, type: 'percentage', value: 10, isActive: true, autoApply: true, combinable: false, createdAt: '2026-01-01T00:00:00Z', ...over }) as Promotion
const line = (productId: string, price: number, quantity = 1): CartItem =>
  ({ productId, productName: productId, variantSize: '100ml', price, quantity, subtotal: price * quantity })
const product = (id: string, price: number): Product => ({ id, name: id, isActive: true, variants: [{ size: '100ml', price, stock: 10 }] }) as unknown as Product
const PRODUCTS = [product('A', 100000), product('B', 50000)]
const fold = (actions: CashierAction[], from: CashierState = CASHIER_INITIAL_STATE): CashierState => actions.reduce(cashierReducer, from)
const reconcile = (s: CashierState, promotions: Promotion[]): CashierState =>
  cashierReducer(s, { type: 'RECONCILE_AUTO_PROMOS', promotions, products: PRODUCTS, ctx })
const withCart = (...items: CartItem[]) => fold(items.map((item) => ({ type: 'CART_ADD_ITEM', item }) as CashierAction))
const bundleOf = (id: string): Promotion =>
  promo(id, { type: 'bundle', value: 0, bundleConfig: { bundlePrice: 120000, maxApplications: 0, slots: [{ productKeys: ['A'], quantity: 1 }, { productKeys: ['B'], quantity: 1 }] } } as Partial<Promotion>)

const AUTO = promo('auto')
const MANUAL_PROMO = promo('man', { autoApply: false, value: 5, combinable: true })

describe('reducer: promo auto-apply state', () => {
  it('RECONCILE_AUTO_PROMOS installs the auto promo and records it as auto', () => {
    const s = reconcile(withCart(line('A', 100000)), [AUTO])
    expect(s.appliedPromotions.map((p) => p.id)).toEqual(['auto'])
    expect(s.autoPromotionIds).toEqual(['auto'])
  })

  it('an x on an auto promo dismisses it; the next reconcile leaves it out', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    const off = cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto' })
    expect(off.appliedPromotions).toEqual([])
    expect(off.autoPromotionIds).toEqual([])
    expect(off.dismissedAutoPromotionIds).toEqual(['auto'])
    const again = reconcile(cashierReducer(off, { type: 'CART_ADD_ITEM', item: line('A', 100000) }), [AUTO])
    expect(again.appliedPromotions).toEqual([])
    expect(again.dismissedAutoPromotionIds).toEqual(['auto'])
  })

  it('removing a manual promo does not touch the dismissed set', () => {
    const s = fold([{ type: 'CART_ADD_ITEM', item: line('A', 100000) }, { type: 'APPLY_PROMOTION', promotion: MANUAL_PROMO }])
    expect(cashierReducer(s, { type: 'REMOVE_PROMOTION', id: 'man' }).dismissedAutoPromotionIds).toEqual([])
  })

  it('Hapus semua dismisses every auto promo and clears the manual one too', () => {
    const base = withCart(line('A', 100000), line('B', 50000))
    const s = reconcile(fold([{ type: 'APPLY_PROMOTION', promotion: MANUAL_PROMO }], base), [promo('auto', { combinable: true })])
    expect(s.autoPromotionIds).toEqual(['auto'])
    const cleared = cashierReducer(s, { type: 'CLEAR_PROMOTIONS' })
    expect(cleared.appliedPromotions).toEqual([])
    expect(cleared.dismissedAutoPromotionIds).toEqual(['auto'])
  })

  it('a promo applied through a typed code is manual: removing the code dismisses nothing', () => {
    const linkedCode = { code: 'X', type: 'percentage', value: 10, combinable: false, promotion: AUTO } as never
    const s = fold([{ type: 'CART_ADD_ITEM', item: line('A', 100000) }, { type: 'APPLY_PROMO_CODE', code: linkedCode, combinable: false }])
    expect(cashierReducer(s, { type: 'REMOVE_PROMO_CODE', code: 'X' }).dismissedAutoPromotionIds).toEqual([])
  })

  it('"+ Tambah" on a dismissed auto promo un-dismisses it and it becomes manual', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    const off = cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto' })
    const manual = cashierReducer(off, { type: 'APPLY_PROMOTION', promotion: AUTO })
    expect(manual.appliedPromotions.map((p) => p.id)).toEqual(['auto'])
    expect(manual.dismissedAutoPromotionIds).toEqual([])
    expect(manual.autoPromotionIds).toEqual([]) // chosen by hand now: the reconcile never removes it
    expect(reconcile(manual, [AUTO]).appliedPromotions.map((p) => p.id)).toEqual(['auto'])
  })

  it('a toggle of an installed auto card is a dismissal; an exclusive manual choice is an eviction, not one', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    expect(cashierReducer(on, { type: 'APPLY_PROMOTION', promotion: AUTO }).dismissedAutoPromotionIds).toEqual(['auto'])
    const evicted = cashierReducer(on, { type: 'APPLY_PROMOTION', promotion: promo('excl', { autoApply: false, combinable: false }) })
    expect(evicted.appliedPromotions.map((p) => p.id)).toEqual(['excl'])
    expect(evicted.dismissedAutoPromotionIds).toEqual([])
    expect(evicted.autoPromotionIds).toEqual([])
    // Removing the manual promo brings the auto one back.
    const back = reconcile(cashierReducer(evicted, { type: 'REMOVE_PROMOTION', id: 'excl' }), [AUTO])
    expect(back.autoPromotionIds).toEqual(['auto'])
  })

  it('a new sale resets the auto fields (CART_CLEAR, RESET_SALE, CLOSE_SUCCESS)', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    const dismissed = cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto' })
    for (const type of ['CART_CLEAR', 'RESET_SALE', 'CLOSE_SUCCESS'] as const) {
      for (const s of [dismissed, on]) {
        const r = cashierReducer(s, { type })
        expect([r.autoPromotionIds, r.dismissedAutoPromotionIds, r.autoPrompts]).toEqual([[], [], []])
      }
    }
  })

  it('a cart edit that evicts an auto promo is not a dismissal (the reconcile owns it)', () => {
    const lowMin = promo('min', { minPurchase: 150000 })
    const on = reconcile(withCart(line('A', 100000, 2)), [lowMin])
    const edited = cashierReducer(on, { type: 'CART_SET_QTY', productId: 'A', variantSize: '100ml', quantity: 1 })
    expect(edited.dismissedAutoPromotionIds).toEqual([])
    const settled = reconcile(edited, [lowMin])
    expect(settled.appliedPromotions).toEqual([])
    const grown = cashierReducer(settled, { type: 'CART_SET_QTY', productId: 'A', variantSize: '100ml', quantity: 2 })
    expect(reconcile(grown, [lowMin]).autoPromotionIds).toEqual(['min'])
  })

  it('SET_DISMISSED_AUTO_PROMOS restores a saved set', () => {
    expect(cashierReducer(CASHIER_INITIAL_STATE, { type: 'SET_DISMISSED_AUTO_PROMOS', ids: ['x', 'x', 'y'] }).dismissedAutoPromotionIds).toEqual(['x', 'y'])
  })

  it('keeps the Promo sheet open while the reconcile installs (activeAdjustment untouched)', () => {
    const open = fold([{ type: 'SET_ACTIVE_ADJUSTMENT', panel: 'promo' }], withCart(line('A', 100000)))
    expect(reconcile(open, [AUTO]).activeAdjustment).toBe('promo')
  })

  it('GATE: with no autoApply promotion nothing changes, and the same state object comes back', () => {
    const s = fold([{ type: 'CART_ADD_ITEM', item: line('A', 100000) }, { type: 'APPLY_PROMOTION', promotion: MANUAL_PROMO }])
    const off = [promo('p1', { autoApply: false }), promo('p2', { autoApply: undefined })]
    expect(reconcile(s, off)).toBe(s)
    expect(reconcile(CASHIER_INITIAL_STATE, [])).toBe(CASHIER_INITIAL_STATE)
    expect(hasAutoPromotions(off)).toBe(false)
    // Every manual action still behaves as before: no auto bookkeeping appears.
    const manual = fold([{ type: 'REMOVE_PROMOTION', id: 'man' }, { type: 'CLEAR_PROMOTIONS' }], s)
    expect([manual.autoPromotionIds, manual.dismissedAutoPromotionIds, manual.autoPrompts]).toEqual([[], [], []])
  })
})

describe('held order and open-cart draft', () => {
  const dismissedState = () => {
    const on = reconcile(withCart(line('A', 100000), line('B', 50000)), [AUTO])
    return cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto' })
  }
  const env = (promotions: Promotion[] = [AUTO]) => ({ products: PRODUCTS, promotions, discountCodes: [], ctx })

  it('stores the dismissed set and never an auto promo', () => {
    const held = heldOrderFromState(dismissedState(), { id: 'h', name: 'n', now: 1 })
    expect(held.dismissedAutoPromotionIds).toEqual(['auto'])
    const heldAuto = heldOrderFromState(reconcile(withCart(line('A', 100000)), [AUTO]), { id: 'h', name: 'n', now: 1 })
    expect(heldAuto.promotions).toEqual([])
    expect('dismissedAutoPromotionIds' in heldAuto).toBe(false)
  })

  it('keeps manual promos in a held order that also had an auto one', () => {
    const s = reconcile(fold([{ type: 'APPLY_PROMOTION', promotion: MANUAL_PROMO }], withCart(line('A', 100000))), [promo('auto', { combinable: true })])
    expect(s.autoPromotionIds).toEqual(['auto'])
    expect(heldOrderFromState(s, { id: 'h', name: 'n', now: 1 }).promotions.map((p) => p.id)).toEqual(['man'])
  })

  it('restore: the dismissed set survives the CART_CLEAR and the restore itself installs no auto promo', () => {
    const held = heldOrderFromState(dismissedState(), { id: 'h', name: 'n', now: 1 })
    const plan = planHeldRestore(held, env())
    expect(plan.actions.map((a) => a.type).slice(0, 2)).toEqual(['CART_CLEAR', 'SET_DISMISSED_AUTO_PROMOS'])
    expect(plan.result.dismissedAutoPromotionIds).toEqual(['auto'])
    expect(plan.result.appliedPromotions).toEqual([])
    expect(reconcile(plan.result, [AUTO]).appliedPromotions).toEqual([])
  })

  it('restore without a dismissed set (an old held order) works and the reconcile installs the auto promo', () => {
    const held = heldOrderFromState(withCart(line('A', 100000)), { id: 'h', name: 'n', now: 1 })
    expect('dismissedAutoPromotionIds' in held).toBe(false)
    const plan = planHeldRestore(held, env())
    expect(plan.actions.map((a) => a.type)).not.toContain('SET_DISMISSED_AUTO_PROMOS')
    expect(plan.result.dismissedAutoPromotionIds).toEqual([])
    expect(reconcile(plan.result, [AUTO]).autoPromotionIds).toEqual(['auto'])
  })

  it('restore ignores a malformed dismissed field', () => {
    const base = heldOrderFromState(withCart(line('A', 100000)), { id: 'h', name: 'n', now: 1 })
    const held = { ...base, dismissedAutoPromotionIds: 'oops' as never }
    expect(planHeldRestore(held, env()).result.dismissedAutoPromotionIds).toEqual([])
  })

  const memKV = (): KV => {
    const m = new Map<string, string>()
    return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k), setDurable: async (k: string, v: string) => void m.set(k, v), removeDurable: async (k: string) => void m.delete(k), keys: () => [...m.keys()] } as unknown as KV
  }
  const src = (s: CashierState) => ({ ...s, isSuccessOpen: false, splitMode: false, tenders: [] })

  it('open-cart draft: carries the dismissed set through the store, v stays 1, an old draft without it restores', async () => {
    const draft = openCartFromState(src(dismissedState()), { saleUuid: 'u', userId: 'u1', now: 1000 })!
    expect(draft.v).toBe(1)
    expect(draft.held.dismissedAutoPromotionIds).toEqual(['auto'])
    const store = new OpenCartStore(memKV(), 'k', () => 1000)
    await store.save(draft)
    expect(planHeldRestore(store.read()!.held, env()).result.dismissedAutoPromotionIds).toEqual(['auto'])

    const oldHeld = { ...draft.held }
    delete oldHeld.dismissedAutoPromotionIds
    await store.save({ ...draft, held: oldHeld })
    const old = store.read()
    expect(old).not.toBeNull()
    expect(decideHydration(old, { userId: 'u1', saleUuids: new Set(), splitDraftOrderUuid: null })).toBe('restore')
    expect(planHeldRestore(old!.held, env()).result.cart).toHaveLength(2)
  })

  it('open-cart draft with an installed auto promo stores the paid lines only (auto is recomputed)', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    const draft = openCartFromState(src(on), { saleUuid: 'u', userId: 'u1', now: 1 })!
    expect(draft.held.promotions).toEqual([])
    expect(draft.held.lines.map((l) => l.productId)).toEqual(['A'])
  })

  it('an auto BUNDLE is stored as its paid lines (moved units put back), nothing else', () => {
    const on = reconcile(withCart(line('A', 100000), line('B', 50000)), [bundleOf('bun')])
    expect(on.autoPromotionIds).toEqual(['bun'])
    const held = heldOrderFromState(on, { id: 'h', name: 'n', now: 1 })
    expect(held.promotions).toEqual([])
    expect(held.rewardPicks).toEqual({})
    expect(held.lines.map((l) => `${l.productId}x${l.quantity}`).sort()).toEqual(['Ax1', 'Bx1'])
  })
})

describe('review fixes', () => {
  it('a restore ends with the reconcile: the saved total comes back (split-draft path reopens checkout at once)', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    const held = heldOrderFromState(on, { id: 'h', name: 'n', now: 1 })
    const plan = planHeldRestore(held, { products: PRODUCTS, promotions: [AUTO], discountCodes: [], ctx })
    expect(plan.actions[plan.actions.length - 1]?.type).toBe('RECONCILE_AUTO_PROMOS')
    expect(plan.result.autoPromotionIds).toEqual(['auto'])
    expect(plan.result.appliedPromotions.map((p) => p.id)).toEqual(['auto'])
  })

  it('a guard removal (lapse) never dismisses; the cashier x on a hand-added autoApply promo does', () => {
    const on = reconcile(withCart(line('A', 100000)), [AUTO])
    expect(cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto', lapse: true }).dismissedAutoPromotionIds).toEqual([])
    const manual = cashierReducer(cashierReducer(on, { type: 'REMOVE_PROMOTION', id: 'auto' }), { type: 'APPLY_PROMOTION', promotion: AUTO })
    const removed = cashierReducer(manual, { type: 'REMOVE_PROMOTION', id: 'auto' })
    expect(removed.dismissedAutoPromotionIds).toEqual(['auto'])
    expect(reconcile(removed, [AUTO]).appliedPromotions).toEqual([])
  })

  it('confirm skips the auto reconcile while payment lines are entered', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(src).toContain('!(state.splitMode && state.tenders.length > 0) && autoSetWouldChange(state, autoEnv)')
  })
})

describe('customerAttachImpact', () => {
  it('does not list an auto bundle or its reward lines, but still lists a manual one', () => {
    const cart = withCart(line('A', 100000), line('B', 50000))
    const autoOn = reconcile(cart, [bundleOf('bun')])
    expect(autoOn.bundleFreed['bun']).toBeDefined()
    expect(customerAttachImpact(autoOn)).toEqual([])
    const manualOn = fold([{ type: 'APPLY_FULFILLMENT', owner: { kind: 'direct', promotion: bundleOf('bun') }, products: PRODUCTS }], cart)
    expect(manualOn.bundleFreed['bun']).toBeDefined()
    expect(customerAttachImpact(manualOn)).toEqual(['bun'])
  })
})

describe('confirm-time reconcile', () => {
  const hours = promo('hours', { activeFromHour: '09:00', activeToHour: '12:00' } as Partial<Promotion>)

  it('reports a change when the auto set lapsed since the cashier looked (hours ended), and not before', () => {
    const early = { promotions: [hours], products: PRODUCTS, ctx: { now: new Date('2026-09-20T03:00:00Z'), outletId: 'outlet' } } // 10:00 WIB
    const on = cashierReducer(withCart(line('A', 100000)), { type: 'RECONCILE_AUTO_PROMOS', ...early })
    expect(on.autoPromotionIds).toEqual(['hours'])
    expect(autoSetWouldChange(on, early)).toBe(false)
    const late = { ...early, ctx: { now: new Date('2026-09-20T06:00:00Z'), outletId: 'outlet' } } // 13:00 WIB
    expect(autoSetWouldChange(on, late)).toBe(true)
  })

  it('a deactivated promo (pull) is a change; with no auto promos and none installed it never is', () => {
    const live = { promotions: [AUTO], products: PRODUCTS, ctx }
    const on = cashierReducer(withCart(line('A', 100000)), { type: 'RECONCILE_AUTO_PROMOS', ...live })
    expect(autoSetWouldChange(on, { ...live, promotions: [{ ...AUTO, isActive: false }] })).toBe(true)
    expect(autoSetWouldChange(withCart(line('A', 100000)), { ...live, promotions: [promo('m', { autoApply: false })] })).toBe(false)
  })

  it('CashierScreen runs it before the existing guards and returns without paying', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const at = src.indexOf('autoSetWouldChange(state, autoEnv)')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(src.indexOf('const invalidPhysical = invalidPhysicalPromotionIds(state)'))
    expect(src.slice(at, at + 330)).toMatch(/Promo otomatis diperbarui, cek total\.[\s\S]*return/)
    // The reactive cleanup never removes an auto promo (that would read as a dismissal).
    expect(src).toContain('if (!state.autoPromotionIds.includes(id)) dispatch({ type: \'REMOVE_PROMOTION\', id })')
  })
})

describe('run gates and fingerprint', () => {
  const open: AutoRunGates = { catalogueReady: true, pickerPending: false, successOpen: false, confirmOpen: false, checkoutOpen: false, processing: false, splitLocked: false }
  it('runs only when nothing holds the total still', () => {
    expect(autoRunAllowed(open)).toBe(true)
    for (const k of ['pickerPending', 'successOpen', 'confirmOpen', 'checkoutOpen', 'processing', 'splitLocked'] as const) expect(autoRunAllowed({ ...open, [k]: true })).toBe(false)
    expect(autoRunAllowed({ ...open, catalogueReady: false })).toBe(false)
  })

  it('an install settles: one extra run, then a fixed point (no loop); an eviction, cart edit, dismissal or promo change moves it', () => {
    const bundle = bundleOf('bun')
    const promos = [AUTO, bundle]
    const cart = withCart(line('A', 100000), line('B', 50000))
    const before = autoReconcileFingerprint(cart, promos, 1)
    const after = reconcile(cart, promos)
    expect(after.autoPromotionIds.length).toBeGreaterThan(0)
    const settled = reconcile(after, promos)
    expect(settled).toBe(after) // the extra run is a no-op
    expect(autoReconcileFingerprint(settled, promos, 1)).toBe(autoReconcileFingerprint(after, promos, 1))
    // An auto bundle evicted by a unit tap leaves the rung cart alone but is still seen.
    const evicted = cashierReducer(after, { type: 'SET_CUSTOMER', customer: null })
    expect(autoReconcileFingerprint(evicted, promos, 1)).not.toBe(autoReconcileFingerprint(after, promos, 1))
    expect(autoReconcileFingerprint(after, promos, 2)).not.toBe(before)
    expect(autoReconcileFingerprint(withCart(line('A', 100000)), promos, 1)).not.toBe(before)
    expect(autoReconcileFingerprint({ ...cart, dismissedAutoPromotionIds: ['auto'] }, promos, 1)).not.toBe(before)
    expect(autoReconcileFingerprint(cart, [AUTO, { ...bundle, isActive: false }], 1)).not.toBe(before)
  })
})

describe('copy', () => {
  const tiered = { type: 'tiered', tieredConfig: { tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 10 }, { minSubtotal: 200000, kind: 'percentage', value: 15 }] } } as never
  it('tiered one-liner joins savings now and the next tier; none at the top tier', () => {
    expect(tieredOneLiner(tiered, 130000, 13000)).toMatch(/^Hemat Rp.13\.000 · belanja Rp.70\.000 lagi untuk hemat 15%$/)
    expect(tieredOneLiner(tiered, 50000, 0)).toMatch(/^Belanja Rp.50\.000 lagi untuk hemat 10%$/)
    expect(tieredOneLiner(tiered, 250000, 37500)).toBeNull()
    expect(tieredOneLiner({ type: 'percentage' } as never, 1, 1)).toBeNull()
  })
  it('prompt rows', () => {
    expect(autoPromptLabel({ promotionId: 'p', promotionName: 'Gratis Tester', reason: 'pick-gift' })).toBe('Promo Gratis Tester berlaku · Pilih hadiah')
    expect(autoPromptLabel({ promotionId: 'p', promotionName: 'Gratis Tester', reason: 'out-of-stock' })).toContain('Stok hadiah habis')
  })
})
