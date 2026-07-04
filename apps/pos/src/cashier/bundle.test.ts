import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { computeBundleFreed } from './bundle'

type CartItem = components['schemas']['CartItem']
type BundleConfig = NonNullable<components['schemas']['Promotion']['bundleConfig']>

// ── fixtures ────────────────────────────────────────────────────────────────
// Owner combo: a 110ml parfum + an atomizer + a 2ml sample, each its own slot.
const P110 = 'p110'
const ATOM = 'atom'
const ATOM_B = 'atomB'
const SAMPLE = 'p2ml'

const line = (
  productId: string,
  price: number,
  quantity = 1,
  variantSize = '',
): CartItem => ({
  productId,
  productName: productId,
  variantSize,
  price,
  quantity,
  subtotal: price * quantity,
})

// Three single-key slots (110ml / atomizer / 2ml), one unit each.
function comboCfg(bundlePrice: number, atomKeys: string[] = [ATOM]): BundleConfig {
  return {
    bundlePrice,
    slots: [
      { productKeys: [P110], quantity: 1 },
      { productKeys: atomKeys, quantity: 1 },
      { productKeys: [SAMPLE], quantity: 1 },
    ],
  }
}

describe('computeBundleFreed — freed set producer (mirrors Go bundleFreedNets)', () => {
  it('frees the cheapest consumed units, keeps the pricey anchor paid', () => {
    // 110ml 575000 + atomizer 225000 + 2ml 1, bundlePrice 575000 → discount 225001
    const cart = [line(P110, 575000), line(ATOM, 225000), line(SAMPLE, 1)]
    const freed = computeBundleFreed(comboCfg(575000), cart)
    expect(freed).not.toBeNull()
    // atomizer and 2ml both drop to 0; 110ml stays paid (not in freed)
    const byId = Object.fromEntries((freed ?? []).map((f) => [f.productId, f]))
    expect(Object.keys(byId).sort()).toEqual([ATOM, SAMPLE].sort())
    expect(byId[ATOM].net).toBe(0)
    expect(byId[ATOM].quantity).toBe(1)
    expect(byId[SAMPLE].net).toBe(0)
    expect(byId[P110]).toBeUndefined()
  })

  it('a partial anchor becomes a reward line at its reduced (non-zero) net', () => {
    // same cart, bundlePrice 700000 → discount 100001: 2ml→0, atomizer→125000, 110ml paid
    const cart = [line(P110, 575000), line(ATOM, 225000), line(SAMPLE, 1)]
    const freed = computeBundleFreed(comboCfg(700000), cart)
    const byId = Object.fromEntries((freed ?? []).map((f) => [f.productId, f]))
    expect(byId[SAMPLE].net).toBe(0)
    expect(byId[ATOM].net).toBe(125000) // partial reward line, not GRATIS
    expect(byId[P110]).toBeUndefined()
  })

  it('two atomizers, no assignment → the cheaper one is consumed+freed, pricier stays paid', () => {
    const cart = [
      line(P110, 575000),
      line(ATOM, 225000),
      line(ATOM_B, 300000),
      line(SAMPLE, 1),
    ]
    const freed = computeBundleFreed(comboCfg(575000, [ATOM, ATOM_B]), cart)
    const byId = Object.fromEntries((freed ?? []).map((f) => [f.productId, f]))
    expect(byId[ATOM]?.net).toBe(0) // cheaper atomizer freed
    expect(byId[ATOM_B]).toBeUndefined() // pricier atomizer never consumed → paid
    expect(byId[SAMPLE].net).toBe(0)
  })

  it('two atomizers, assignment picks the pricier → that one is consumed+freed', () => {
    const cart = [
      line(P110, 575000),
      line(ATOM, 225000),
      line(ATOM_B, 300000),
      line(SAMPLE, 1),
    ]
    // assignment: slot index 1 consumes atomB instead of the default cheapest
    const freed = computeBundleFreed(comboCfg(575000, [ATOM, ATOM_B]), cart, {
      1: [{ productId: ATOM_B, variantSize: '' }],
    })
    const byId = Object.fromEntries((freed ?? []).map((f) => [f.productId, f]))
    expect(byId[ATOM_B]?.net).toBe(0) // chosen pricier atomizer freed
    expect(byId[ATOM]).toBeUndefined() // cheaper atomizer stays paid (not consumed)
    expect(byId[SAMPLE].net).toBe(0)
  })

  it('returns null when a slot is unsatisfiable (bundle not applicable)', () => {
    // no 2ml sample in cart → slot 3 empty → nApp 0
    const cart = [line(P110, 575000), line(ATOM, 225000)]
    expect(computeBundleFreed(comboCfg(575000), cart)).toBeNull()
  })

  it('ignores existing reward lines when counting eligibility', () => {
    const cart: CartItem[] = [
      line(P110, 575000),
      line(ATOM, 225000),
      line(SAMPLE, 1),
      { ...line(ATOM, 0), isReward: true, rewardPromotionId: 'other' },
    ]
    const freed = computeBundleFreed(comboCfg(575000), cart)
    // still exactly one application; atomizer freed once (reward line not double-counted)
    const atom = (freed ?? []).find((f) => f.productId === ATOM)
    expect(atom?.quantity).toBe(1)
  })
})
