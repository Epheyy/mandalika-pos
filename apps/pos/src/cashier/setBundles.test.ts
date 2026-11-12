import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import {
  buildBundleLines,
  bundleDiscountGain,
  cardOffers,
  lineShort,
  minNet,
  nextBundleGroup,
  offerButtonMode,
  offerSoldOut,
  repriceBundles,
  splitBundleAmount,
  swapCandidates,
  type Basis,
  type BundleCatalog,
  type BundleOffer,
} from './setBundles'
import { CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const GOLDEN = new URL('../../../../backend/internal/bundles/testdata/split_golden.json', import.meta.url)
interface Case { name: string; amount: number; basis: Basis; expected: [number, number, number]; minNet: number }
const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Case[]

const EXT = 'EXTRAIT DE PARFUM'
const v = (size: string, price: number, stock = 10) => ({ size, price, stock, sku: size })
const prod = (id: string, name: string, variants: Product['variants']): Product =>
  ({ id, name, brand: 'b', categoryId: 'c', variants, isFeatured: false, isFavourite: false }) as Product

const champion = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
const blue = prod('blue', 'BLUE', [v('10ml ATOMIZER', 300000), v('2ml EXTRAIT', 60000)])
const offer = (over: Partial<BundleOffer> = {}): BundleOffer => ({
  line: EXT, lineLabel: 'Extrait', lineShort: 'EXT', size: '120ml', price: 850000,
  largeVariantSize: '120ml EXTRAIT', atomizerVariantSize: '10ml ATOMIZER', vialVariantSize: '2ml EXTRAIT', ...over,
})
const catalog: BundleCatalog = {
  lines: [],
  products: [{ productId: 'champ', productName: 'CHAMPION', offers: [offer()], missing: [] }],
  pieces: [
    { productId: 'champ', variantSize: '10ml ATOMIZER', role: 'atomizer', line: '', size: '10ml' },
    { productId: 'blue', variantSize: '10ml ATOMIZER', role: 'atomizer', line: '', size: '10ml' },
    { productId: 'champ', variantSize: '2ml EXTRAIT', role: 'vial', line: EXT, size: '2ml' },
    { productId: 'blue', variantSize: '2ml EXTRAIT', role: 'vial', line: EXT, size: '2ml' },
    { productId: 'blue', variantSize: '2ml PI', role: 'vial', line: 'PARFUM INTENSE', size: '2ml' },
  ],
}
const stateOf = (cart: CartItem[]): CashierState => ({ ...CASHIER_INITIAL_STATE, cart })

describe('split twin', () => {
  it.each(cases)('split golden matches Go: $name', (c) => {
    expect(splitBundleAmount(c.amount, c.basis)).toEqual(c.expected)
    expect(minNet(c.basis)).toBe(c.minNet)
  })
  it('throws on a basis <= 0, non-integers and values over 1e9', () => {
    expect(() => splitBundleAmount(100, [0, 1, 1])).toThrow()
    expect(() => splitBundleAmount(100.5, [1, 1, 1])).toThrow()
    expect(() => splitBundleAmount(100, [1e9 + 1, 1, 1])).toThrow()
  })
  it('stays exact at the 1e9 limit', () => {
    const [l, a, vv] = splitBundleAmount(1e9, [1e9, 1e9, 1e9])
    expect(l + a + vv).toBe(1e9)
  })
})

describe('offers and labels', () => {
  it('offerButtonMode 1→buttons, 2→buttons, 4→list', () => {
    const o = offer()
    expect(offerButtonMode([])).toBe('none')
    expect(offerButtonMode([o])).toBe('buttons')
    expect(offerButtonMode([o, o])).toBe('buttons')
    expect(offerButtonMode([o, o, o, o])).toBe('list')
  })
  it('cardOffers reads the product offers', () => {
    expect(cardOffers(catalog, 'champ')).toHaveLength(1)
    expect(cardOffers(catalog, 'x')).toEqual([])
    expect(cardOffers(undefined, 'champ')).toEqual([])
  })
  it('lineShort maps EXTRAIT DE PARFUM→EXT, PARFUM INTENSE→PI, ""→""', () => {
    expect(lineShort(EXT)).toBe('EXT')
    expect(lineShort('PARFUM INTENSE')).toBe('PI')
    expect(lineShort('')).toBe('')
    expect(lineShort('X')).toBe('X')
  })
})

describe('buildBundleLines', () => {
  it('CHAMPION EXT 120ml gives 3 qty-1 lines summing to 850000', () => {
    const { lines, needsSwap } = buildBundleLines(offer(), champion, [champion, blue], 1)
    expect(lines.map((l) => l.bundleRole)).toEqual(['large', 'atomizer', 'vial'])
    expect(lines.every((l) => l.quantity === 1 && l.bundleGroup === 1 && l.bundlePrice === 850000)).toBe(true)
    expect(lines.reduce((s, l) => s + l.subtotal, 0)).toBe(850000)
    expect(lines.map((l) => l.bundleBasisPrice)).toEqual([1200000, 250000, 60000])
    expect(lines[0]).toMatchObject({ bundleLine: EXT, bundleSize: '120ml' })
    expect(needsSwap).toEqual([])
  })
  it('flags atomizer when its stock is 0', () => {
    const dry = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000, 0), v('2ml EXTRAIT', 60000)])
    expect(buildBundleLines(offer(), dry, [dry], 1).needsSwap).toEqual(['atomizer'])
  })
  it('flags both when both are out, counting the cart', () => {
    const dry = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000, 0), v('2ml EXTRAIT', 60000, 1)])
    const cart: CartItem[] = [{ productId: 'champ', productName: 'CHAMPION', variantSize: '2ml EXTRAIT', price: 60000, quantity: 1, subtotal: 60000 }]
    expect(buildBundleLines(offer(), dry, [dry], 1, cart).needsSwap).toEqual(['atomizer', 'vial'])
  })
  it('adds nothing when a piece has no positive price', () => {
    const bad = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 0), v('2ml EXTRAIT', 60000)])
    expect(buildBundleLines(offer(), bad, [bad], 1).lines).toEqual([])
  })
  it('nextBundleGroup is max + 1 from 1', () => {
    expect(nextBundleGroup([])).toBe(1)
    const { lines } = buildBundleLines(offer(), champion, [champion], 3)
    expect(nextBundleGroup(lines)).toBe(4)
  })
})

describe('stock helpers', () => {
  it('offerSoldOut subtracts the large bottle already in the cart (stock 1, one in cart → sold out)', () => {
    const one = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000, 1), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
    expect(offerSoldOut(offer(), 'champ', [one], [])).toBe(false)
    const cart: CartItem[] = [{ productId: 'champ', productName: 'CHAMPION', variantSize: '120ml EXTRAIT', price: 1, quantity: 1, subtotal: 1 }]
    expect(offerSoldOut(offer(), 'champ', [one], cart)).toBe(true)
  })
})

describe('swapCandidates', () => {
  const products = [champion, blue]
  it('vial offers only same-line 2ml', () => {
    const r = swapCandidates(catalog, products, [], 'vial', EXT)
    expect(r.map((x) => `${x.productId}|${x.variantSize}`)).toEqual(['blue|2ml EXTRAIT', 'champ|2ml EXTRAIT'])
  })
  it('atomizer offers every fragrance, sorted by name', () => {
    expect(swapCandidates(catalog, products, [], 'atomizer', '').map((x) => x.productName)).toEqual(['BLUE', 'CHAMPION'])
  })
  it('excludes zero-price variants', () => {
    const free = prod('blue', 'BLUE', [v('10ml ATOMIZER', 0), v('2ml EXTRAIT', 60000)])
    expect(swapCandidates(catalog, [champion, free], [], 'atomizer', '').map((x) => x.productId)).toEqual(['champ'])
  })
  it('excludes out-of-stock (incl. in-cart quantity) and keeps untracked stock', () => {
    const one = prod('blue', 'BLUE', [v('10ml ATOMIZER', 300000, 1), v('2ml EXTRAIT', 60000)])
    const cart: CartItem[] = [{ productId: 'blue', productName: 'BLUE', variantSize: '10ml ATOMIZER', price: 1, quantity: 1, subtotal: 1 }]
    expect(swapCandidates(catalog, [champion, one], cart, 'atomizer', '').map((x) => x.productId)).toEqual(['champ'])
    const untracked = prod('blue', 'BLUE', [{ ...v('10ml ATOMIZER', 300000), stock: Number.NaN }, v('2ml EXTRAIT', 60000)])
    expect(swapCandidates(catalog, [untracked], [], 'atomizer', '')).toHaveLength(1)
  })
  it('excludes the current piece', () => {
    const r = swapCandidates(catalog, products, [], 'atomizer', '', { productId: 'champ', variantSize: '10ml ATOMIZER' })
    expect(r.map((x) => x.productId)).toEqual(['blue'])
  })
})

describe('repriceBundles', () => {
  const bundle = () => buildBundleLines(offer(), champion, [champion], 1).lines
  it('is idempotent and returns the same object', () => {
    const s = stateOf(bundle())
    expect(repriceBundles(s)).toBe(s)
  })
  it('keeps Σ = bundlePrice after a swap to a pricier atomizer', () => {
    const cart = bundle().map((l) =>
      l.bundleRole === 'atomizer' ? { ...l, productId: 'blue', productName: 'BLUE', bundleBasisPrice: 300000 } : l)
    const out = repriceBundles(stateOf(cart))
    expect(out.cart.reduce((n, l) => n + l.subtotal, 0)).toBe(850000)
    expect(out.cart[1].price).toBe(163461)
    expect(repriceBundles(out)).toBe(out)
  })
  it('never throws: bad basis or net under minNet keeps prices', () => {
    const bad = stateOf(bundle().map((l) => (l.bundleRole === 'vial' ? { ...l, bundleBasisPrice: 0 } : l)))
    expect(repriceBundles(bad)).toBe(bad)
    const low = stateOf(bundle().map((l) => ({ ...l, bundlePrice: 5 })))
    expect(repriceBundles(low)).toBe(low)
    const huge = stateOf(bundle().map((l) => ({ ...l, bundleBasisPrice: 2e9 })))
    expect(() => repriceBundles(huge)).not.toThrow()
  })
})

describe('bundleDiscountGain', () => {
  type Promotion = components['schemas']['Promotion']
  const bd = (id: string, kind: 'percentage' | 'fixed', value: number): Promotion =>
    ({ id, name: id, type: 'bundle_discount', value, isActive: true, createdAt: '', combinable: true, bundleDiscountConfig: { kind } }) as Promotion
  it('counts the whole applied discount (all three pieces), so a smaller promo gains 0', () => {
    const ten = bd('ten', 'percentage', 10)
    const base = { ...CASHIER_INITIAL_STATE, cart: buildBundleLines(offer(), champion, [champion], 1).lines, appliedPromotions: [ten] }
    const priced = repriceBundles(base)
    expect(priced.cart.reduce((n, l) => n + l.subtotal, 0)).toBe(765000)
    expect(bundleDiscountGain(bd('eighty', 'fixed', 80000), priced)).toBe(0)
    expect(bundleDiscountGain(bd('hundred', 'fixed', 100000), priced)).toBe(15000)
  })
})
