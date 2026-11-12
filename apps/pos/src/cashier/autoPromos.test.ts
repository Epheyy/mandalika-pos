import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { reconcileAutoPromos, type AutoPromoInput, type AutoReconcileResult } from './autoPromos'
import { unmetCartPrecondition } from './promoEligibility'
import { validatePromo } from './promoValidate'
import { computePricing, type PricingInput } from './pricing'
import { CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const NOW = new Date('2026-09-20T05:00:00Z')
const ctx = { now: NOW, outletId: 'outlet' }

const promo = (id: string, over: Partial<Promotion> = {}): Promotion =>
  ({ id, name: id, type: 'percentage', value: 10, isActive: true, autoApply: true, combinable: true, createdAt: '2026-01-01T00:00:00Z', ...over }) as Promotion

const line = (productId: string, price: number, quantity = 1, variantSize = '100ml'): CartItem =>
  ({ productId, productName: productId, variantSize, price, quantity, subtotal: price * quantity })

const product = (id: string, price: number, stock = 10): Product =>
  ({ id, name: id, variants: [{ size: '100ml', price, stock }] }) as unknown as Product

const PRODUCTS = [product('A', 100000), product('B', 50000), product('G', 80000), product('G2', 60000)]

const stateWith = (cart: CartItem[], over: Partial<CashierState> = {}): CashierState => ({ ...CASHIER_INITIAL_STATE, cart, ...over })

const run = (
  state: CashierState, promotions: Promotion[],
  over: Partial<AutoPromoInput> = {},
): AutoReconcileResult =>
  reconcileAutoPromos({ state, autoPromotionIds: [], dismissedPromotionIds: [], promotions, products: PRODUCTS, ctx, ...over })

const ids = (r: AutoReconcileResult) => r.autoPromotionIds
const total = (s: CashierState) => computePricing({
  cart: s.cart, discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
  appliedPromotions: s.appliedPromotions, appliedPromoCodes: s.appliedPromoCodes,
  settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as unknown as PricingInput['settings'],
  loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as unknown as PricingInput['loyalty'],
  hasCustomer: false, pointsRedeemed: 0, customerPoints: 0,
}).total

const bxgy = (id: string, getIds: string[], over: Partial<Promotion> = {}): Promotion =>
  promo(id, {
    type: 'buy_x_get_y', value: 0,
    bxgyConfig: { buyProductIds: ['A'], buyQuantity: 1, getProductIds: getIds, getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: 0 },
    ...over,
  } as Partial<Promotion>)

const bundle = (id: string, over: Partial<Promotion> = {}): Promotion =>
  promo(id, {
    type: 'bundle', value: 0, combinable: false,
    bundleConfig: { bundlePrice: 120000, maxApplications: 0, slots: [{ productKeys: ['A'], quantity: 1 }, { productKeys: ['B'], quantity: 1 }] },
    ...over,
  } as Partial<Promotion>)

describe('reconcileAutoPromos', () => {
  it('installs a qualifying auto promo and ignores non-auto, codeOnly, inactive and dismissed ones', () => {
    const s = stateWith([line('A', 100000)])
    const r = run(s, [
      promo('auto'), promo('manual', { autoApply: false, value: 50 }),
      promo('code', { codeOnly: true, value: 50 }), promo('off', { isActive: false, value: 50 }),
    ])
    expect(ids(r)).toEqual(['auto'])
    expect(r.next.appliedPromotions.map((p) => p.id)).toEqual(['auto'])
    expect(r.changed).toBe(true)
    expect(ids(run(s, [promo('auto')], { dismissedPromotionIds: ['auto'] }))).toEqual([])
  })

  it('is idempotent: reconciling its own output changes nothing', () => {
    const promotions = [promo('p10'), bundle('bun'), bxgy('gift', ['G'])]
    const s = stateWith([line('A', 100000, 2), line('B', 50000)])
    const first = run(s, promotions)
    expect(first.changed).toBe(true)
    const second = run(first.next, promotions, { autoPromotionIds: first.autoPromotionIds })
    expect(second.changed).toBe(false)
    expect(second.autoPromotionIds).toEqual(first.autoPromotionIds)
  })

  it('drops an auto promo that stops qualifying and brings it back', () => {
    const p = promo('min', { minPurchase: 150000 })
    const full = run(stateWith([line('A', 100000, 2)]), [p])
    expect(ids(full)).toEqual(['min'])
    const lowered = run(stateWith([line('A', 100000)], { appliedPromotions: full.next.appliedPromotions }), [p], { autoPromotionIds: ['min'] })
    expect(ids(lowered)).toEqual([])
    expect(lowered.next.appliedPromotions).toEqual([])
    expect(lowered.changed).toBe(true)
  })

  describe('manual wins', () => {
    const s = (over: Partial<CashierState>) => stateWith([line('A', 100000)], over)

    it('an exclusive manual promo holds every auto promo back', () => {
      const manual = promo('m', { autoApply: false, combinable: false })
      const r = run(s({ appliedPromotions: [manual] }), [promo('auto')])
      expect(ids(r)).toEqual([])
      expect(r.next.appliedPromotions.map((p) => p.id)).toEqual(['m'])
    })

    it('an exclusive manual code holds auto promos back', () => {
      const code = { code: 'X', value: 5, type: 'percentage' as const, combinable: false }
      expect(ids(run(s({ appliedPromoCodes: [code] }), [promo('auto')]))).toEqual([])
    })

    it('a combinable manual promo admits only combinable auto promos', () => {
      const manual = promo('m', { autoApply: false })
      const r = run(s({ appliedPromotions: [manual] }), [promo('stack', { value: 5 }), promo('solo', { combinable: false, value: 90 })])
      expect(ids(r)).toEqual(['stack'])
      expect(r.next.appliedPromotions.map((p) => p.id).sort()).toEqual(['m', 'stack'])
    })

    it('never installs a promo the cashier already applied', () => {
      const manual = promo('same')
      expect(ids(run(s({ appliedPromotions: [manual] }), [manual]))).toEqual([])
    })
  })

  describe('winner among exclusive promos', () => {
    const s = stateWith([line('A', 100000)])
    it('the biggest saving wins', () => {
      const r = run(s, [promo('small', { combinable: false, value: 10 }), promo('big', { combinable: false, value: 30 })])
      expect(ids(r)).toEqual(['big'])
      expect(total(r.next)).toBe(70000)
    })

    it('stackable promos count as one option and can beat an exclusive one', () => {
      const r = run(s, [promo('a', { value: 20 }), promo('b', { value: 15 }), promo('x', { combinable: false, value: 30 })])
      expect(ids(r).sort()).toEqual(['a', 'b'])
    })

    it('a tie goes to the older promo, then the lowest id', () => {
      const older = promo('z-old', { combinable: false, createdAt: '2025-01-01T00:00:00Z' })
      const newer = promo('a-new', { combinable: false, createdAt: '2026-01-01T00:00:00Z' })
      expect(ids(run(s, [newer, older]))).toEqual(['z-old'])
      const t1 = promo('b', { combinable: false }), t2 = promo('a', { combinable: false })
      expect(ids(run(s, [t1, t2]))).toEqual(['a'])
    })

    it('counts a bundle saving (reward lines) against a plain discount', () => {
      const cart = stateWith([line('A', 100000), line('B', 50000)])
      // bundle price 120000 saves 30000; 10% saves 15000
      const win = run(cart, [bundle('bun'), promo('ten', { combinable: false, value: 10 })])
      expect(ids(win)).toEqual(['bun'])
      // 30% saves 45000 and beats the bundle
      const lose = run(cart, [bundle('bun'), promo('thirty', { combinable: false, value: 30 })])
      expect(ids(lose)).toEqual(['thirty'])
    })

    it('counts a separate-set BXGY gift value', () => {
      const cart = stateWith([line('A', 100000)])
      // free G (80000) beats 10% (10000), loses to 90%
      expect(ids(run(cart, [bxgy('gift', ['G'], { combinable: false }), promo('ten', { combinable: false })]))).toEqual(['gift'])
      expect(ids(run(cart, [bxgy('gift', ['G'], { combinable: false }), promo('ninety', { combinable: false, value: 90 })]))).toEqual(['ninety'])
    })
  })

  describe('gifts that need a choice or stock', () => {
    it('a single gift with qty 1 auto-applies', () => {
      const r = run(stateWith([line('A', 100000)]), [bxgy('gift', ['G'])])
      expect(ids(r)).toEqual(['gift'])
      const reward = r.next.cart.find((c) => c.isReward)
      expect(reward).toMatchObject({ productId: 'G', quantity: 1, price: 0, rewardPromotionId: 'gift' })
      expect(r.prompts).toEqual([])
    })

    it('several gift options give a prompt and install nothing', () => {
      const r = run(stateWith([line('A', 100000)]), [bxgy('gift', ['G', 'G2'])])
      expect(ids(r)).toEqual([])
      expect(r.next.cart.some((c) => c.isReward)).toBe(false)
      expect(r.prompts).toEqual([{ promotionId: 'gift', promotionName: 'gift', reason: 'pick-gift' }])
    })

    it('a gift quantity above 1 gives a prompt', () => {
      const r = run(stateWith([line('A', 100000, 2)]), [bxgy('gift', ['G'])])
      expect(ids(r)).toEqual([])
      expect(r.prompts[0]?.reason).toBe('pick-gift')
    })

    it('a gift variant with stock 0 gives a prompt, not a free line', () => {
      const r = run(stateWith([line('A', 100000)]), [bxgy('gift', ['G'])], { products: [product('A', 100000), product('G', 80000, 0)] })
      expect(ids(r)).toEqual([])
      expect(r.next.cart.some((c) => c.isReward)).toBe(false)
      expect(r.prompts).toEqual([{ promotionId: 'gift', promotionName: 'gift', reason: 'out-of-stock' }])
    })

    it('a bundle with extra eligible units needs a pick; an exact bundle applies', () => {
      const exact = run(stateWith([line('A', 100000), line('B', 50000)]), [bundle('bun')])
      expect(ids(exact)).toEqual(['bun'])
      expect(exact.next.bundleFreed.bun).toBeDefined()
      const extra = run(stateWith([line('A', 100000, 2), line('B', 50000)]), [bundle('bun')])
      expect(ids(extra)).toEqual([])
      expect(extra.prompts[0]).toMatchObject({ promotionId: 'bun', reason: 'pick-gift' })
    })

    it('a prompted promo is not reported when something else installed it', () => {
      const r = run(stateWith([line('A', 100000)]), [bxgy('gift', ['G'])])
      expect(r.prompts).toEqual([])
    })
  })

  describe('min-purchase chain', () => {
    it('drops a promo whose minPurchase the bundle repricing broke, within 2 passes', () => {
      // Cart 150000. Bundle (priced 120000) is installed first and lowers the
      // subtotal to 120000, under the 140000 minimum of the stacked percentage promo.
      const cart = stateWith([line('A', 100000), line('B', 50000)])
      const chain = promo('pct', { value: 10, combinable: true, minPurchase: 140000 })
      const bun = bundle('bun', { combinable: true })
      const r = run(cart, [bun, chain])
      expect(ids(r)).toEqual(['bun'])
      expect(r.next.appliedPromotions.map((p) => p.id)).toEqual(['bun'])
      const again = run(r.next, [bun, chain], { autoPromotionIds: r.autoPromotionIds })
      expect(again.changed).toBe(false)
    })
  })

  describe('settle pass', () => {
    it('drops an earlier physical promo whose minPurchase a later bundle broke', () => {
      const cart = stateWith([line('A', 100000), line('B', 50000)])
      // gift installs first (older, subtotal 150000 >= 140000); the bundle then
      // reprices the cart to 120000, so the settle pass removes the gift again.
      const gift = bxgy('gift', ['G'], { minPurchase: 140000, createdAt: '2025-01-01T00:00:00Z' })
      const bun = bundle('bun', { combinable: true })
      const r = run(cart, [gift, bun])
      expect(ids(r)).toEqual(['bun'])
      expect(r.next.cart.some((c) => c.isReward && c.rewardPromotionId === 'gift')).toBe(false)
      expect(run(r.next, [gift, bun], { autoPromotionIds: r.autoPromotionIds }).changed).toBe(false)
    })
  })

  describe('an auto promo never breaks a manual one', () => {
    const cart = [line('A', 100000), line('B', 50000)]
    it('skips an auto bundle that drops the subtotal under a manual minPurchase', () => {
      const manual = promo('m', { autoApply: false, minPurchase: 140000 })
      const r = run(stateWith(cart, { appliedPromotions: [manual] }), [bundle('bun', { combinable: true })])
      expect(ids(r)).toEqual([])
      expect(r.next.cart.some((c) => c.isReward)).toBe(false)
    })
    it('skips an auto bundle that takes the units of a manual gift', () => {
      const mg = bxgy('mg', ['G'], {
        autoApply: false,
        bxgyConfig: { buyProductIds: ['B'], buyQuantity: 1, getProductIds: ['G'], getQuantity: 1, getDiscountKind: 'percentage', getDiscountValue: 100, maxApplications: 0 },
      })
      const gift: CartItem = { ...line('G', 80000), price: 0, subtotal: 0, isReward: true, rewardPromotionId: 'mg' }
      const r = run(stateWith([...cart, gift], { appliedPromotions: [mg] }), [bundle('bun', { combinable: true })])
      expect(ids(r)).toEqual([])
      expect(r.next.appliedPromotions.map((p) => p.id)).toEqual(['mg'])
    })
  })

  it('caps combined gifts of one variant at stock (two promos, stock 1)', () => {
    const g1 = bxgy('g1', ['G'], { createdAt: '2025-01-01T00:00:00Z' })
    const g2 = bxgy('g2', ['G'])
    const r = run(stateWith([line('A', 100000)]), [g1, g2], { products: [product('A', 100000), product('G', 80000, 1)] })
    expect(ids(r)).toEqual(['g1'])
    expect(r.prompts).toEqual([{ promotionId: 'g2', promotionName: 'g2', reason: 'out-of-stock' }])
  })

  it('reports a changed promo with the same id and returns the caller state when unchanged', () => {
    const old = promo('p', { value: 10 })
    const s = stateWith([line('A', 100000)], { appliedPromotions: [old] })
    const edited = run(s, [promo('p', { value: 20 })], { autoPromotionIds: ['p'] })
    expect(edited.changed).toBe(true)
    expect(edited.next.appliedPromotions[0].value).toBe(20)
    const same = run(s, [old], { autoPromotionIds: ['p'] })
    expect(same.changed).toBe(false)
    expect(same.next).toBe(s)
  })

  describe('every output is valid', () => {
    it('passes validatePromo and the combinability rule', () => {
      const promotions = [
        promo('a', { value: 5 }), promo('b', { value: 8, minPurchase: 100 }),
        bundle('bun', { combinable: true }), bxgy('gift', ['G']),
        promo('x', { combinable: false, value: 12 }),
        promo('late', { startDate: '2099-01-01' }), promo('wrongOutlet', { outletIds: ['other'] }),
      ]
      for (const cart of [[line('A', 100000)], [line('A', 100000), line('B', 50000)], [line('A', 300000, 3), line('B', 50000, 2)]]) {
        const r = run(stateWith(cart), promotions)
        const subtotal = r.next.cart.reduce((n, c) => n + c.subtotal, 0)
        for (const p of r.next.appliedPromotions) {
          expect(validatePromo(p, { ...ctx, subtotal, hasCustomer: false })).toEqual([])
        }
        const discounts = r.next.appliedPromotions.length + r.next.appliedPromoCodes.length
        if (discounts > 1) expect(r.next.appliedPromotions.every((p) => p.combinable)).toBe(true)
        expect(r.next.appliedPromotions.map((p) => p.id).sort()).toEqual([...r.autoPromotionIds].sort())
      }
    })

    it('does not move paid units out of the sale: rung units are conserved', () => {
      const s = stateWith([line('A', 100000), line('B', 50000)])
      const r = run(s, [bundle('bun')])
      const units = (c: CartItem[]) => c.reduce((n, l) => n + l.quantity, 0)
      expect(units(r.next.cart)).toBe(units(s.cart))
    })
  })
})

describe('promoEligibility (panel behaviour preserved)', () => {
  const cart = [line('A', 100000)]
  it('separate-set BXGY needs buy criteria; same-set needs savings', () => {
    expect(unmetCartPrecondition(bxgy('g', ['G']), cart, 0)).toBeNull()
    expect(unmetCartPrecondition(bxgy('g', ['G']), [line('B', 5)], 0)).toBe('bxgy')
    const same = bxgy('same', [])
    expect(unmetCartPrecondition(same, cart, 0)).toBe('bxgy')
    expect(unmetCartPrecondition(same, cart, 5)).toBeNull()
  })
  it('a bundle needs one complete set from paid lines only', () => {
    expect(unmetCartPrecondition(bundle('b'), cart, 0)).toBe('bundle')
    expect(unmetCartPrecondition(bundle('b'), [line('A', 1), line('B', 1)], 0)).toBeNull()
    expect(unmetCartPrecondition(bundle('b'), [line('A', 1), { ...line('B', 1), isReward: true }], 0)).toBe('bundle')
  })
  it('other promo types have no cart precondition', () => {
    expect(unmetCartPrecondition(promo('p'), cart, 0)).toBeNull()
  })
})

describe('Diskon Bundle auto-apply', () => {
  const EXTL = 'EXTRAIT DE PARFUM'
  const piece = (role: 'large' | 'atomizer' | 'vial', price: number, basis: number): CartItem => ({
    productId: 'champ', productName: 'CHAMPION', variantSize: role, price, quantity: 1, subtotal: price,
    bundleGroup: 1, bundleRole: role, bundlePrice: 850000, bundleBasisPrice: basis, bundleLine: EXTL, bundleSize: '120ml', bundleDiscount: 0,
  })
  const bundleCart = (): CartItem[] => [piece('large', 675498, 1200000), piece('atomizer', 140728, 250000), piece('vial', 33774, 60000)]
  const diskon = (id: string, kind: 'percentage' | 'fixed', value: number, over: Partial<Promotion> = {}): Promotion =>
    promo(id, { type: 'bundle_discount', value, bundleDiscountConfig: { kind, lines: [], sizes: [] }, ...over } as Partial<Promotion>)
  const base = () => stateWith(bundleCart())

  it('reconcileAutoPromos installs an auto Diskon Bundle (saving > 0)', () => {
    const r = run(base(), [diskon('d', 'percentage', 10)])
    expect(ids(r)).toEqual(['d'])
    expect(r.next.cart.reduce((n, c) => n + c.subtotal, 0)).toBe(765000)
    expect(run(r.next, [diskon('d', 'percentage', 10)], { autoPromotionIds: ['d'] }).changed).toBe(false)
  })

  it('reconcileAutoPromos holds Diskon Bundle back behind an exclusive code', () => {
    const s = stateWith(bundleCart(), { appliedPromoCodes: [{ code: 'X', value: 5, type: 'percentage', combinable: false }] })
    const r = run(s, [diskon('d', 'percentage', 10)])
    expect(ids(r)).toEqual([])
    expect(r.next.cart.reduce((n, c) => n + c.subtotal, 0)).toBe(850000)
  })

  it('reconcileAutoPromos keeps Diskon Bundle beside a combinable standalone code', () => {
    const s = stateWith(bundleCart(), { appliedPromoCodes: [{ code: 'X', value: 5, type: 'percentage', combinable: true }] })
    const r = run(s, [diskon('d', 'percentage', 10)])
    expect(ids(r)).toEqual(['d'])
    expect(r.next.appliedPromoCodes).toHaveLength(1)
    expect(r.next.cart.reduce((n, c) => n + c.subtotal, 0)).toBe(765000)
  })

  it('settle drops a Diskon Bundle that wins no bundle', () => {
    const r = run(base(), [diskon('small', 'percentage', 10), diskon('big', 'fixed', 100000)])
    expect(ids(r)).toEqual(['big'])
    expect(r.next.cart.reduce((n, c) => n + c.subtotal, 0)).toBe(750000)
  })

  it('skips a Diskon Bundle when no bundle matches', () => {
    const r = run(base(), [diskon('d', 'percentage', 10, { bundleDiscountConfig: { kind: 'percentage', lines: ['PARFUM INTENSE'], sizes: [] } } as Partial<Promotion>)])
    expect(ids(r)).toEqual([])
  })
})
