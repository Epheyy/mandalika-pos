import type { components } from '@mandalika/api'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Cart, lineSubtitle } from './Cart'

type CartItem = components['schemas']['CartItem']
type Product = components['schemas']['Product']

const item = { productId: 'p1', productName: 'Alpha', variantSize: 'M', quantity: 2, price: 100000, subtotal: 200000 } as CartItem
const products = [{ id: 'p1', categoryId: 'c1' } as Product]
const categories = [{ id: 'c1', name: 'Extrait' } as components['schemas']['Category']]

describe('lineSubtitle (W1-24)', () => {
  it('joins the size label and the category name', () => {
    expect(lineSubtitle(item, products, categories)).toBe('M · Extrait')
  })
  it('falls back to the size alone for an unknown category or a missing product', () => {
    expect(lineSubtitle(item, products, [])).toBe('M')
    expect(lineSubtitle({ ...item, productId: 'zz' }, products, categories)).toBe('M')
  })
})

describe('Cart column (F1)', () => {
  const noop = () => {}
  const props = {
    cart: [item], giveaway: null, derived: { subtotal: 200000, total: 180000, discountAmount: 20000, totalCartItems: 2 } as never,
    settings: { taxEnabled: false } as never, customerSlot: null, pendingSync: false, products, categories,
    onRemove: noop, onSetQty: noop, onSwitchSize: () => true, heldCount: 0, onOpenHeld: noop, onClear: noop, onCheckout: noop,
    onOpenAdjustment: noop, discountRunning: 0, discountType: 'fixed' as const, surchargeRunning: 0, orderNotes: '',
    appliedPromotions: [], appliedPromoCodes: [], onClearDiscount: noop, onRemovePromotion: noop, onRemovePromoCode: noop,
  }
  const html = (over: object = {}) => renderToStaticMarkup(createElement(Cart, { ...props, wallRaised: false, ...over }))

  it('shows one quantity pill per line (no stepper) and the category subtitle', () => {
    const out = html()
    expect(out).not.toContain('aria-label="Kurangi"')
    expect(out).toContain('M · Extrait')
    expect(out).toContain('2 barang')
  })

  it('keeps the button names the browser flows use, the action row after the totals, and one total on the Bayar bar', () => {
    const out = html()
    expect(out).toContain('aria-label="Promo &amp; Diskon"')
    expect(out).toContain('Kosongkan')
    expect(out).toContain('aria-label="Bayar"')
    expect(out.indexOf('Total hemat')).toBeLessThan(out.indexOf('Kosongkan'))
    expect(out).not.toContain('Hemat promo')
    expect(out).toContain('aria-describedby="cart-total"')
    expect(out).toContain('id="cart-total"')
  })

  it('still shows the total when the sync wall disables Bayar', () => {
    const out = html({ wallRaised: true })
    expect(out).toContain('Sinkronisasi diperlukan')
    expect(out).toMatch(/Sinkronisasi diperlukan<\/span><span[^>]*>Rp\s?180\.000/)
  })
})
