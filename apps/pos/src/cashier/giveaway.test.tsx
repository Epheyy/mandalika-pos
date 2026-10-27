import { readFileSync } from 'node:fs'
import type { components } from '@mandalika/api'
import { buildReceipt } from '@mandalika/printer'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Cart } from './Cart'
import { GIVEAWAY_CAPTION, GIVEAWAY_OUT_OF_STOCK, giveawayLine, giveawayStock, type GiveawayConfig } from './giveaway'
import { ReceiptPreview } from './ReceiptPreview'
import { buildReceiptQuote, receiptAddsUp, receiptFromQuote } from './receiptQuote'
import { receiptTotalRows } from './receiptRows'

type Product = components['schemas']['Product']

const config: GiveawayConfig = { productId: 'bag', variantSize: 'std', productName: 'Tote Bag', stock: 7 }
const paid = { productId: 'p1', productName: 'Oud', variantSize: '50ml', price: 100000, quantity: 1, subtotal: 100000 }
const reward = { ...paid, isReward: true, price: 0, subtotal: 0 }
const catalog = (stock: number): Product[] => [{ id: 'bag', name: 'Tote Bag', variants: [{ size: 'std', price: 0, stock, sku: 'B' }] } as unknown as Product]

describe('C3 giveawayLine', () => {
  it('is a Rp0 reward line for the configured item when the cart has a line', () => {
    expect(giveawayLine([paid], config, 5)).toEqual({
      productId: 'bag', productName: 'Tote Bag', variantSize: 'std', quantity: 1, price: 0, subtotal: 0, isReward: true, outOfStock: false,
    })
  })

  it.each([
    ['empty cart', []],
    ['a zero-quantity line', [{ ...paid, quantity: 0 }]],
  ])('is null for %s', (_n, cart) => {
    expect(giveawayLine(cart, config, 5)).toBeNull()
  })

  it('still shows for a reward-only cart: the server gives one per completed order', () => {
    expect(giveawayLine([reward], config, 5)).not.toBeNull()
  })

  it('is null without a configured giveaway', () => {
    expect(giveawayLine([paid], undefined, 5)).toBeNull()
    expect(giveawayLine([paid], null, 5)).toBeNull()
  })

  it('flags stock at or below zero, never hides the line', () => {
    expect(giveawayLine([paid], config, 0)?.outOfStock).toBe(true)
    expect(giveawayLine([paid], config, -3)?.outOfStock).toBe(true)
    expect(giveawayLine([paid], config, 1)?.outOfStock).toBe(false)
  })

  it('does not touch the cart it reads', () => {
    const cart = [paid]
    giveawayLine(cart, config, 5)
    expect(cart).toEqual([paid])
  })
})

describe('C3 giveawayStock', () => {
  it('uses the pending-adjusted catalog when the item is listed', () => {
    expect(giveawayStock(config, catalog(2), { 'bag|std': 9 })).toBe(2)
  })
  it('falls back to the pulled stock minus unsynced sales when the item is not in the catalog', () => {
    expect(giveawayStock(config, [], { 'bag|std': 3 })).toBe(4)
    expect(giveawayStock({ ...config, stock: undefined }, [], {})).toBe(0)
  })
})

describe('C3 payload and validator exclusion', () => {
  it('the giveaway reaches only the cart panel, the receipt preview and the quote (not validator, loyalty or payload)', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
    const uses = src.split(/\r?\n/).filter((l) => /\bgiveaway\b/.test(l) && !l.trim().startsWith('//')).map((l) => l.trim())
    expect(uses.filter((l) => !/giveawayConfig|giveawayLine|giveawayStock|<Cart|giveaway=\{giveaway\}|cart: giveaway|import /.test(l))).toEqual([])
  })

  it('the order payload sends state.cart; only the quote carries the giveaway', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
    expect(src).toContain('items: state.cart,')
    expect(src).toContain('cart: giveaway ? [...state.cart, giveaway] : state.cart')
    expect(src).not.toMatch(/dispatch\(\{ type: '[A-Z_]+', [^}]*giveaway/)
  })
})

describe('C3 receipt', () => {
  const derived = { subtotal: 100000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 100000 }
  const extras = { orderRef: 'T1', dateTime: new Date('2026-10-27T03:00:00Z'), paymentLabel: 'Tunai', customerName: null, customerPhone: null, cashierName: 'Kasir' }
  const gl = giveawayLine([paid], config, 5)!

  it('the quote carries a Rp0 reward line and the slip still adds up', () => {
    const q = buildReceiptQuote({ cart: [paid, gl], derived, tender: { amountPaid: 100000, change: 0 }, refVersion: 1 })
    expect(q.receiptSnapshot.lines.at(-1)).toMatchObject({ productId: 'bag', name: 'Tote Bag', qty: 1, amount: 0, isReward: true })
    expect(q.quotedTotal).toBe(100000)
    const data = receiptFromQuote(q, extras)
    expect(receiptAddsUp(data)).toBe(true)
    expect(data.lines.at(-1)).toMatchObject({ name: 'Tote Bag', variant: 'std', isReward: true, amount: 0 })
    expect(receiptTotalRows(data, { showSubtotal: true, showDiscount: true, showTax: true }).at(-1)?.amount).toBe(100000)
  })

  it('the printed slip shows HADIAH and GRATIS for it', () => {
    const q = buildReceiptQuote({ cart: [paid, gl], derived, tender: { amountPaid: 100000, change: 0 }, refVersion: 1 })
    const bytes = buildReceipt(receiptFromQuote(q, extras), { headerText: '', footerText: '', showTax: true, showSubtotal: true, showDiscount: true } as never)
    const text = String.fromCharCode(...bytes)
    expect(text).toContain('Tote Bag')
    expect(text).toContain('[HADIAH]')
    expect(text).toContain('GRATIS')
  })

  it('a sale without a giveaway keeps the old lines', () => {
    const q = buildReceiptQuote({ cart: [paid], derived, tender: { amountPaid: 100000, change: 0 }, refVersion: 1 })
    expect(q.receiptSnapshot.lines).toHaveLength(1)
  })
})

describe('C3 rendering', () => {
  const noop = () => {}
  const cartProps = {
    cart: [paid], derived: { subtotal: 100000, total: 100000, totalCartItems: 1 } as never, settings: { taxEnabled: false } as never,
    customerSlot: null, pendingSync: false, products: [], onRemove: noop, onSetQty: noop, onSwitchSize: () => true,
    heldCount: 0, onOpenHeld: noop, onClear: noop, onCheckout: noop, onOpenAdjustment: noop, discountRunning: 0,
    discountType: 'fixed' as const, surchargeRunning: 0, orderNotes: '', appliedPromotions: [], appliedPromoCodes: [],
    onClearDiscount: noop, onRemovePromotion: noop, onRemovePromoCode: noop, wallRaised: false,
  }
  const html = (giveaway: ReturnType<typeof giveawayLine>) => renderToStaticMarkup(createElement(Cart, { ...cartProps, giveaway }))

  it('the cart shows HADIAH, name and size, caption, qty 1 and GRATIS in the reward colour; no stock warning in stock', () => {
    const out = html(giveawayLine([paid], config, 5))
    expect(out).toContain('data-testid="giveaway-line"')
    expect(out).toContain('Tote Bag')
    expect(out).toContain('HADIAH')
    expect(out).toContain(GIVEAWAY_CAPTION)
    expect(out).toContain('text-reward')
    expect(out).toContain('GRATIS')
    expect(out).not.toContain(GIVEAWAY_OUT_OF_STOCK)
  })

  it('shows Stok hadiah habis in warn when out of stock, and nothing without a giveaway', () => {
    const out = html(giveawayLine([paid], config, 0))
    expect(out).toContain(GIVEAWAY_OUT_OF_STOCK)
    expect(out).toContain('text-warn')
    expect(html(null)).not.toContain('giveaway-line')
  })

  it('has no stepper or remove control on the giveaway line', () => {
    const out = html(giveawayLine([paid], config, 5))
    const line = out.slice(out.indexOf('data-testid="giveaway-line"'))
    const end = line.indexOf('</div></div>')
    expect(line.slice(0, end)).not.toContain('<button')
  })

  it('the on-screen receipt lists the giveaway row as GRATIS', () => {
    const props = {
      isOpen: true, orderId: 'o1', orderNumber: 'T1', items: [paid], totalRows: [], paymentMethod: 'cash', amountPaid: 100000, change: 0,
      customerName: null, cashierName: 'K', settings: { receipt: { headerText: '' } } as never, orderState: 'unknown' as const,
      isPendingSync: false, canReprint: false, printError: null, onReprint: noop, onClose: noop, onNewSale: noop,
    }
    const withIt = renderToStaticMarkup(createElement(ReceiptPreview, { ...props, giveaway: giveawayLine([paid], config, 5) }))
    expect(withIt).toContain('data-testid="receipt-giveaway"')
    expect(withIt).toContain('Tote Bag')
    expect(renderToStaticMarkup(createElement(ReceiptPreview, props))).not.toContain('receipt-giveaway')
  })
})
