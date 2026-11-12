import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { buildBundleLines, repriceBundles, type BundleOffer } from './setBundles'
import { computePricing, type PricingInput } from './pricing'
import { unmetCartPrecondition } from './promoEligibility'
import { removePromotionEffect } from './promotionEffects'
import { bundleReceiptLine, collapseBundleLines, fromOrderItem } from './bundleReceipt'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierState } from './state/cashierReducer'

type Product = components['schemas']['Product']
type Promotion = components['schemas']['Promotion']

const EXT = 'EXTRAIT DE PARFUM'
const v = (size: string, price: number) => ({ size, price, stock: 10, sku: size })
const champion = { id: 'champ', name: 'CHAMPION', brand: 'b', categoryId: 'c', isFeatured: false, isFavourite: false,
  variants: [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)] } as Product
const offer: BundleOffer = {
  line: EXT, lineLabel: 'Extrait', lineShort: 'EXT', size: '120ml', price: 850000,
  largeVariantSize: '120ml EXTRAIT', atomizerVariantSize: '10ml ATOMIZER', vialVariantSize: '2ml EXTRAIT',
}
const diskon = (id: string, kind: 'percentage' | 'fixed', value: number, over: Partial<Promotion> = {}): Promotion =>
  ({ id, name: `Diskon ${id}`, type: 'bundle_discount', value, isActive: true, combinable: true, createdAt: '',
    bundleDiscountConfig: { kind, lines: [], sizes: [] }, ...over }) as Promotion

const bundleCart = (group = 1) => buildBundleLines(offer, champion, [champion], group).lines
const stateWith = (promos: Promotion[]): CashierState => ({ ...CASHIER_INITIAL_STATE, cart: bundleCart(), appliedPromotions: promos })
const sum = (s: CashierState) => s.cart.reduce((n, l) => n + l.subtotal, 0)
const discountOf = (s: CashierState) => s.cart.reduce((n, l) => n + (l.bundleDiscount ?? 0), 0)

describe('repriceBundles with Diskon Bundle', () => {
  it('applies 10% to an EXT 120ml bundle: sum = 765000', () => {
    const out = repriceBundles(stateWith([diskon('a', 'percentage', 10)]))
    expect(sum(out)).toBe(765000)
    expect(discountOf(out)).toBe(85000)
    expect(out.cart.map((l) => l.bundleDiscount)).toEqual([67551, 14072, 3377])
    expect(out.cart.every((l) => l.bundlePromotionId === 'a')).toBe(true)
    expect(repriceBundles(out)).toBe(out)
  })

  it('only the bigger of two Diskon Bundles applies per bundle', () => {
    const out = repriceBundles(stateWith([diskon('a', 'percentage', 10), diskon('b', 'fixed', 100000)]))
    expect(discountOf(out)).toBe(100000)
    expect(out.cart.every((l) => l.bundlePromotionId === 'b')).toBe(true)
  })

  it('removing the promotion restores bundle prices', () => {
    const on = repriceBundles(stateWith([diskon('a', 'percentage', 10)]))
    const off = repriceBundles(removePromotionEffect(on, 'a'))
    expect(sum(off)).toBe(850000)
    expect(discountOf(off)).toBe(0)
    expect(off.cart.some((l) => l.bundlePromotionId !== undefined)).toBe(false)
  })

  it('a linked promo code applies the same discount', () => {
    const p = diskon('a', 'percentage', 10)
    const s: CashierState = { ...CASHIER_INITIAL_STATE, cart: bundleCart(), appliedPromoCodes: [{
      code: 'BUN10', value: 10, type: 'bundle_discount' as Promotion['type'], combinable: true,
      promotion: { id: 'a', type: 'bundle_discount', value: 10, isBOGO: false, bundleDiscountConfig: p.bundleDiscountConfig },
    }] }
    expect(sum(repriceBundles(s))).toBe(765000)
  })

  it('the reducer reprices on APPLY_PROMOTION', () => {
    const s = cashierReducer({ ...CASHIER_INITIAL_STATE, cart: bundleCart() }, { type: 'APPLY_PROMOTION', promotion: diskon('a', 'percentage', 10) })
    expect(sum(s)).toBe(765000)
  })

  it('an unscoped 10% promo after Diskon Bundle uses the reduced subtotal', () => {
    const pct: Promotion = { id: 'p', name: 'p', type: 'percentage', value: 10, isActive: true, combinable: true, createdAt: '' } as Promotion
    const s = repriceBundles(stateWith([diskon('a', 'percentage', 10), pct]))
    const r = computePricing({
      cart: s.cart, discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
      appliedPromotions: s.appliedPromotions, appliedPromoCodes: [],
      settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as unknown as PricingInput['settings'],
      loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as unknown as PricingInput['loyalty'],
      hasCustomer: false, pointsRedeemed: 0, customerPoints: 0,
    })
    expect(r.appliedPromoDiscountAmount).toBe(76500)
  })
})

describe('unmetCartPrecondition for bundle_discount', () => {
  it('is bundle-discount when no bundle matches, null when one does', () => {
    const p = diskon('a', 'percentage', 10, { bundleDiscountConfig: { kind: 'percentage', lines: ['PARFUM INTENSE'], sizes: [] } })
    expect(unmetCartPrecondition(p, [], 0)).toBe('bundle-discount')
    expect(unmetCartPrecondition(p, bundleCart(), 0)).toBe('bundle-discount')
    expect(unmetCartPrecondition(diskon('b', 'percentage', 10), bundleCart(), 0)).toBeNull()
  })
})

describe('Diskon Bundle receipt', () => {
  it('prints the discount under the bundle line with an ASCII label', () => {
    const cart = repriceBundles(stateWith([diskon('a', 'percentage', 10)])).cart
    const lines = cart.map((c) => ({ ...fromOrderItem(c), item: c }))
    const [entry] = collapseBundleLines(lines, () => 'Diskon Lebaran – Spesial é')
    expect(entry.kind).toBe('bundle')
    if (entry.kind !== 'bundle') return
    const rl = bundleReceiptLine(entry)
    expect(rl.amount).toBe(765000)
    expect(rl.unitPrice).toBe(850000)
    expect(rl.lineDiscount?.amount).toBe(85000)
    expect(rl.lineDiscount?.label).toMatch(/^[\x20-\x7e]+$/)
    expect(rl.lineDiscount?.label).toContain('Diskon Lebaran')
  })
})
