import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierAction, type CashierState } from './state/cashierReducer'
import { buildBundleLines, type BundleCatalog, type BundleOffer } from './setBundles'
import { planSizeSwitch } from './lineSizes'
import { refundGroups, withSaleLineData } from './saleLineData'
import { heldOrderFromState } from './heldOrders'
import { planHeldRestore, type HeldRestoreEnv } from './heldRestore'
import { openCartFromState, revalidationDelta } from './openCartDraft'
import { buildRefundBasis, lineLockReason, selectAll, selectionToItems, setLineQty, toggleLine, EMPTY_SELECTION } from './refundSelection'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']
type Order = components['schemas']['Order']

const EXT = 'EXTRAIT DE PARFUM'
const v = (size: string, price: number, stock = 10) => ({ size, price, stock, sku: size })
const prod = (id: string, name: string, variants: Product['variants']): Product =>
  ({ id, name, brand: 'b', categoryId: 'c', isActive: true, variants, isFeatured: false, isFavourite: false }) as Product
const champion = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
const blue = prod('blue', 'BLUE', [v('10ml ATOMIZER', 300000), v('2ml EXTRAIT', 60000)])
const products = [champion, blue]
const offer: BundleOffer = {
  line: EXT, lineLabel: 'Extrait', lineShort: 'EXT', size: '120ml', price: 850000,
  largeVariantSize: '120ml EXTRAIT', atomizerVariantSize: '10ml ATOMIZER', vialVariantSize: '2ml EXTRAIT',
}
const catalog: BundleCatalog = {
  lines: [],
  products: [{ productId: 'champ', productName: 'CHAMPION', offers: [offer], missing: [] }],
  pieces: [],
}
const single = (size: string, price: number, qty = 1): CartItem => ({ productId: 'champ', productName: 'CHAMPION', variantSize: size, price, quantity: qty, subtotal: price * qty })
const run = (s: CashierState, ...actions: CashierAction[]) => actions.reduce(cashierReducer, s)
const bundleLines = (group: number) => buildBundleLines(offer, champion, products, group).lines
const sum = (cart: CartItem[]) => cart.reduce((n, c) => n + c.subtotal, 0)

describe('bundle cart reducer', () => {
  it('CART_ADD_ITEM of the large bottle next to a bundle adds a separate single line', () => {
    const s = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) }, { type: 'CART_ADD_ITEM', item: single('120ml EXTRAIT', 1200000) })
    expect(s.cart).toHaveLength(4)
    expect(s.cart.filter((c) => c.bundleGroup == null)).toHaveLength(1)
    expect(sum(s.cart)).toBe(850000 + 1200000)
  })
  it('CART_REMOVE_ITEM removes the single and keeps the bundle large piece', () => {
    let s = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) }, { type: 'CART_ADD_ITEM', item: single('120ml EXTRAIT', 1200000) })
    s = run(s, { type: 'CART_REMOVE_ITEM', productId: 'champ', variantSize: '120ml EXTRAIT' })
    expect(s.cart).toHaveLength(3)
    expect(s.cart.every((c) => c.bundleGroup === 1)).toBe(true)
  })
  it('CART_SET_QTY never touches a piece', () => {
    const s0 = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) })
    const s = run(s0, { type: 'CART_SET_QTY', productId: 'champ', variantSize: '120ml EXTRAIT', quantity: 5 })
    expect(s.cart).toEqual(s0.cart)
    expect(run(s0, { type: 'CART_SET_QTY', productId: 'champ', variantSize: '120ml EXTRAIT', quantity: 0 }).cart).toHaveLength(3)
  })
  it('CART_SWAP_BUNDLE_PIECE swaps the atomizer and keeps Σ = 850000', () => {
    const s = run(
      CASHIER_INITIAL_STATE,
      { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) },
      { type: 'CART_SWAP_BUNDLE_PIECE', bundleGroup: 1, role: 'atomizer', piece: { productId: 'blue', productName: 'BLUE', variantSize: '10ml ATOMIZER', basisPrice: 300000 } },
    )
    const atom = s.cart.find((c) => c.bundleRole === 'atomizer')
    expect(atom).toMatchObject({ productId: 'blue', bundleBasisPrice: 300000 })
    expect(sum(s.cart)).toBe(850000)
    expect(atom?.price).toBe(163461)
  })
  it('a swap with a basis of 0 or an unknown group changes nothing', () => {
    const s0 = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) })
    expect(run(s0, { type: 'CART_SWAP_BUNDLE_PIECE', bundleGroup: 1, role: 'vial', piece: { productId: 'blue', productName: 'BLUE', variantSize: '2ml EXTRAIT', basisPrice: 0 } })).toBe(s0)
    expect(run(s0, { type: 'CART_SWAP_BUNDLE_PIECE', bundleGroup: 9, role: 'vial', piece: { productId: 'blue', productName: 'BLUE', variantSize: '2ml EXTRAIT', basisPrice: 1 } })).toBe(s0)
  })
  it('CART_REMOVE_SET_BUNDLE removes exactly its 3 lines', () => {
    const s = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) }, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(2) }, { type: 'CART_REMOVE_SET_BUNDLE', bundleGroup: 1 })
    expect(s.cart).toHaveLength(3)
    expect(s.cart.every((c) => c.bundleGroup === 2)).toBe(true)
  })
  it('two bundles of the same offer stay two groups; a duplicate group number or partial group is refused', () => {
    const s = run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) }, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(2) })
    expect(s.cart).toHaveLength(6)
    expect(run(s, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(2) })).toBe(s)
    expect(run(s, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(3).slice(0, 2) })).toBe(s)
  })
  it('planSizeSwitch returns null for a piece', () => {
    const piece = bundleLines(1)[0]
    expect(planSizeSwitch(piece, champion, '10ml ATOMIZER')).toBeNull()
  })
})

describe('refund group and sale line data', () => {
  it('refundGroups gives set:1 to the three pieces and null to singles', () => {
    const cart = [...bundleLines(1), single('120ml EXTRAIT', 1200000)]
    expect(refundGroups(cart, () => undefined)).toEqual(['set:1', 'set:1', 'set:1', null])
  })
  it('withSaleLineData carries set:<n> and nets that add up for a bundle sale', () => {
    const cart = bundleLines(1)
    const out = withSaleLineData({ cart, appliedPromotions: [], appliedPromoCodes: [], discountType: 'fixed', discountRunning: 0, total: 850000, knownPromotions: [] })
    expect(out?.map((l) => l.refundGroup)).toEqual(['set:1', 'set:1', 'set:1'])
    expect(out?.reduce((n, l) => n + (l.netAmount ?? 0), 0)).toBe(850000)
  })
  it('a scoped promo skips pieces when attributing its discount', () => {
    const scoped = { id: 'p', name: 'P', type: 'percentage', value: 10, applicableProductIds: ['champ'], isActive: true, createdAt: '' } as never
    const cart = [...bundleLines(1), single('120ml EXTRAIT', 1000000)]
    const out = withSaleLineData({ cart, appliedPromotions: [scoped], appliedPromoCodes: [], discountType: 'fixed', discountRunning: 0, total: 850000 + 900000, knownPromotions: [scoped] })
    expect(out?.slice(0, 3).map((l, i) => l.netAmount === cart[i].subtotal)).toEqual([true, true, true])
    expect(out?.[3].netAmount).toBe(900000)
  })
})

describe('refundSelection with a bundle', () => {
  const serverOrder = (): Order => {
    const items = bundleLines(1).map((l, i) => ({ ...l, lineNo: i, netAmount: l.subtotal, refundGroup: 'set:1' }))
    return { id: 'o1', orderNumber: 'BSD-1', status: 'completed', total: 850000, paymentMethod: 'cash', createdAt: '', items } as unknown as Order
  }
  it('selects the whole bundle when one piece is ticked; the group locks after a partial', () => {
    const b = buildRefundBasis(serverOrder())
    if (b.kind !== 'lines') throw new Error('lines')
    const sel = toggleLine(b.lines, EMPTY_SELECTION, 0)
    expect(selectionToItems(b.lines, sel).map((i) => i.lineNo)).toEqual([0, 1, 2])
    expect(selectionToItems(b.lines, selectAll(b.lines))).toHaveLength(3)
    // one piece already refunded elsewhere: the rest are locked
    const partial = b.lines.map((l, i) => (i === 0 ? { ...l, refundedQty: 1, remainingQty: 0 } : l))
    expect(lineLockReason(partial[1], partial)).not.toBeNull()
    expect(selectionToItems(partial, setLineQty(partial, EMPTY_SELECTION, 1, 1))).toEqual([])
  })
})

describe('hold, restore and draft', () => {
  const env = (over: Partial<HeldRestoreEnv> = {}): HeldRestoreEnv => ({
    products, promotions: [], discountCodes: [], bundleCatalog: catalog, ctx: { now: new Date('2026-06-13T07:30:00Z'), outletId: 'o1' }, ...over,
  })
  const twoBundles = () => run(CASHIER_INITIAL_STATE, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(1) }, { type: 'CART_ADD_SET_BUNDLE', lines: bundleLines(2) })
  const hold = (s: CashierState) => heldOrderFromState(s, { id: 'h', name: 'n', now: 1 })

  it('hold and restore a cart with two bundles of the same offer: 6 lines, 2 groups, Σ unchanged', () => {
    const s = twoBundles()
    const plan = planHeldRestore(hold(s), env())
    expect(plan.result.cart).toHaveLength(6)
    expect(new Set(plan.result.cart.map((c) => c.bundleGroup)).size).toBe(2)
    expect(sum(plan.result.cart)).toBe(1700000)
    expect(plan.lossless).toBe(true)
  })
  it('restore after a bundle price change uses the current offer price', () => {
    const plan = planHeldRestore(hold(twoBundles()), env({ bundleCatalog: { ...catalog, products: [{ ...catalog.products[0], offers: [{ ...offer, price: 900000 }] }] } }))
    expect(sum(plan.result.cart)).toBe(1800000)
    expect(plan.result.cart.every((c) => c.bundlePrice === 900000)).toBe(true)
  })
  it('restore of a bundle whose offer is gone leaves it out with the note', () => {
    const plan = planHeldRestore(hold(twoBundles()), env({ bundleCatalog: { lines: [], products: [], pieces: [] } }))
    expect(plan.result.cart).toHaveLength(0)
    expect(plan.notes.some((n) => n.startsWith('Bundle CHAMPION') && n.endsWith('tidak bisa dipulihkan'))).toBe(true)
    expect(plan.lossless).toBe(false)
  })
  it('a swapped piece restores with the swapped product', () => {
    const swapped = run(twoBundles(), { type: 'CART_SWAP_BUNDLE_PIECE', bundleGroup: 1, role: 'atomizer', piece: { productId: 'blue', productName: 'BLUE', variantSize: '10ml ATOMIZER', basisPrice: 300000 } })
    const plan = planHeldRestore(hold(swapped), env())
    expect(plan.result.cart.find((c) => c.bundleGroup === 1 && c.bundleRole === 'atomizer')?.productId).toBe('blue')
    expect(sum(plan.result.cart)).toBe(1700000)
  })
  it('open-cart draft round-trips bundle fields and does not call a piece repriced', () => {
    const s = twoBundles()
    const draft = openCartFromState(s, { saleUuid: 'u', userId: 'x', now: 1 })
    expect(draft?.held.lines.filter((l) => l.bundleGroup === 1)).toHaveLength(3)
    expect(draft?.held.lines[0]).toMatchObject({ bundleRole: 'large', bundlePrice: 850000, bundleBasisPrice: 1200000 })
    expect(revalidationDelta(draft!.held, products)).toEqual({ unavailable: 0, repriced: 0 })
  })
})
