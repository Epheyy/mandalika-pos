import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { LocalReceipt } from '@mandalika/sync'
import { buildReceipt } from '@mandalika/printer'
import { bundleReceiptLine, collapseBundleLines, fromOrderItem, fromSnapshotLine } from './bundleReceipt'
import { buildReceiptQuote, receiptAddsUp, receiptFromQuote, type QuoteDerived } from './receiptQuote'
import { localReceiptOrder, reprintReceiptData } from './localReceipts'
import { buildRefundBasis } from './refundSelection'
import { buildBundleLines, type BundleOffer } from './setBundles'
import { withSaleLineData } from './saleLineData'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const EXT = 'EXTRAIT DE PARFUM'
const v = (size: string, price: number) => ({ size, price, stock: 9, sku: size })
const champion = { id: 'champ', name: 'CHAMPION', variants: [v('120ml EXTRAIT DE PARFUM', 1200000), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT DE PARFUM', 60000)] } as unknown as Product
const offer: BundleOffer = {
  line: EXT, lineLabel: 'Extrait', lineShort: 'EXT', size: '120ml', price: 850000,
  largeVariantSize: '120ml EXTRAIT DE PARFUM', atomizerVariantSize: '10ml ATOMIZER', vialVariantSize: '2ml EXTRAIT DE PARFUM',
}
const pieces = (): CartItem[] => buildBundleLines(offer, champion, [champion], 1).lines
const single: CartItem = { productId: 'x', productName: 'MUSK', variantSize: '50ml', price: 100000, quantity: 2, subtotal: 200000 }
const derived = (subtotal: number): QuoteDerived => ({ subtotal, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: subtotal })
const names = () => undefined

describe('collapseBundleLines', () => {
  it('collapses a group into one entry at the large piece, keeps singles in order', () => {
    const cart = [single, ...pieces()]
    const out = collapseBundleLines(cart.map((c) => ({ ...fromOrderItem(c), c })), names)
    expect(out.map((e) => e.kind)).toEqual(['single', 'bundle'])
    const b = out[1]
    if (b.kind !== 'bundle') throw new Error('bundle')
    expect(b.name).toBe('CHAMPION · Bundle EXT 120ml')
    expect(b.pieces).toEqual(['CHAMPION 120ml EXTRAIT DE PARFUM', 'CHAMPION 10ml ATOMIZER', 'CHAMPION 2ml EXTRAIT DE PARFUM'])
    expect(b.amount).toBe(850000)
    expect(b.price).toBe(850000)
    expect(b.discount).toBe(0)
  })
  it('lists pieces in role order even when the stored order differs; a swapped piece shows its own name', () => {
    const [l, a, vi] = pieces()
    const swapped = { ...a, productName: 'BLUE' }
    const out = collapseBundleLines([vi, swapped, l].map((c) => ({ ...fromOrderItem(c) })), names)
    const b = out[0]
    if (b.kind !== 'bundle') throw new Error('bundle')
    expect(b.pieces[1]).toBe('BLUE 10ml ATOMIZER')
    expect(out).toHaveLength(1)
  })
  it('a line without a line name reads "Bundle 110ml"; a Diskon Bundle uses the promotion name or the default', () => {
    const p = pieces().map((c) => ({ ...c, bundleLine: '', bundleSize: '110ml', bundleDiscount: 10, bundlePromotionId: 'pr' }))
    const named = collapseBundleLines(p.map(fromOrderItem), (id) => (id === 'pr' ? 'Promo Akhir Tahun' : undefined))[0]
    const plain = collapseBundleLines(p.map(fromOrderItem), names)[0]
    if (named.kind !== 'bundle' || plain.kind !== 'bundle') throw new Error('bundle')
    expect(named.name).toBe('CHAMPION · Bundle 110ml')
    expect(named.discount).toBe(30)
    expect(named.price).toBe(850030)
    expect(named.discountLabel).toBe('Promo Akhir Tahun')
    expect(plain.discountLabel).toBe('Diskon Bundle')
  })
  it('lines without a bundle group are untouched', () => {
    const out = collapseBundleLines([fromOrderItem(single)], names)
    expect(out).toEqual([{ kind: 'single', line: fromOrderItem(single) }])
  })
  it('fromSnapshotLine copies the bundle fields', () => {
    const l = { name: 'A', variantSize: '1ml', amount: 5, bundleGroup: 2, bundleRole: 'vial' as const }
    expect(fromSnapshotLine(l)).toMatchObject({ name: 'A', amount: 5, bundleGroup: 2, bundleRole: 'vial' })
  })
})

describe('receipt quote with a bundle', () => {
  const cart = [single, ...pieces()]
  const quote = () => buildReceiptQuote({ cart, derived: derived(1050000), tender: { amountPaid: 1100000, change: 50000 }, refVersion: 1 })
  const extras = { orderRef: 'T-1', dateTime: new Date('2026-11-12T03:00:00Z'), paymentLabel: 'Tunai', customerName: null, customerPhone: null, cashierName: 'Kasir' }

  it('buildReceiptQuote keeps one snapshot line per piece with bundle fields, v unchanged', () => {
    const q = quote()
    expect(q.receiptSnapshot.v).toBe(2)
    expect(q.receiptSnapshot.lines).toHaveLength(4)
    expect(q.receiptSnapshot.lines[1]).toMatchObject({ bundleGroup: 1, bundleRole: 'large', bundleLine: EXT, bundleSize: '120ml' })
    expect(q.receiptSnapshot.lines[0]).not.toHaveProperty('bundleGroup')
  })
  it('receiptFromQuote prints one line per bundle and the slip still adds up', () => {
    const data = receiptFromQuote(quote(), extras)
    expect(data.lines).toHaveLength(2)
    expect(data.lines[1]).toMatchObject({ name: 'CHAMPION · Bundle EXT 120ml', qty: 1, unitPrice: 850000, amount: 850000 })
    expect(data.lines[1].pieces).toHaveLength(3)
    expect(receiptAddsUp(data)).toBe(true)
  })
  it('receiptFromQuote of a snapshot without bundle fields is unchanged', () => {
    const q = buildReceiptQuote({ cart: [single], derived: derived(200000), tender: { amountPaid: 200000, change: 0 }, refVersion: 1 })
    const data = receiptFromQuote(q, extras)
    expect(data.lines).toEqual([{ name: 'MUSK', variant: '50ml', qty: 2, unitPrice: 100000, amount: 200000, isReward: false }])
  })
  it('the printed slip shows the name, the pieces and the bundle price within 32 columns', () => {
    const text = slipText(buildReceipt(receiptFromQuote(quote(), extras), { headerText: '', footerText: '', showTax: true } as never))
    expect(text.every((l) => l.length <= 32)).toBe(true)
    expect(text.some((l) => l.startsWith('CHAMPION - Bundle EXT 120ml'))).toBe(true)
    expect(text.filter((l) => l.startsWith('  + '))).toHaveLength(3)
    expect(text.some((l) => /^ {2}1 x 850\.000\s+850\.000$/.test(l))).toBe(true)
  })
})

describe('a Diskon Bundle line prints under the bundle (printer)', () => {
  it('amount column = bundle price, the discount row follows, totals add up', () => {
    const line = bundleReceiptLine({ kind: 'bundle', group: 1, name: 'CHAMPION · Bundle EXT 120ml', pieces: ['A', 'B', 'C'], price: 850000, discount: 85000, discountLabel: 'Promo Akhir Tahun', amount: 765000 })
    expect(line).toMatchObject({ unitPrice: 850000, amount: 765000, lineDiscount: { label: 'Promo Akhir Tahun', amount: 85000 } })
    const text = slipText(buildReceipt({
      orderRef: 'T', pending: false, dateTime: new Date(0), lines: [line], subtotal: 765000, discountAmount: 0, discounts: [], taxAmount: 0, total: 765000,
      paymentLabel: 'Tunai', amountPaid: 765000, change: 0, customerName: null, customerPhone: null, cashierName: 'K',
    }, { headerText: '', footerText: '', showTax: true } as never))
    expect(text.some((l) => /^ {2}1 x 850\.000\s+850\.000$/.test(l))).toBe(true)
    expect(text.some((l) => l.startsWith('  - Promo Akhir Tahun') && /-Rp ?85.000$/.test(l))).toBe(true)
  })
})

describe('local receipt of an unsynced bundle sale', () => {
  const lines = [single, ...pieces()]
  const sale = withSaleLineData({ cart: lines, appliedPromotions: [], appliedPromoCodes: [], discountType: 'fixed', discountRunning: 0, total: 1050000, knownPromotions: [] })!
  const q = buildReceiptQuote({ cart: lines, derived: derived(1050000), tender: { amountPaid: 1050000, change: 0 }, refVersion: 1 })
  const rec = (): LocalReceipt => ({
    orderUuid: 'u-1', idempotencyKey: 'dev:u-1', orderNumber: 'BSD-G1', capturedAt: '2026-11-12T03:00:00.000Z', outletId: 'o', shiftId: 's',
    paymentMethod: 'cash', quotedTotal: 1050000, receiptSnapshot: q.receiptSnapshot, state: 'queued', refundQueued: false, refunded: false,
    lineNets: sale.map((l) => l.netAmount as number), lineGroups: sale.map((l) => l.refundGroup ?? null),
  }) as LocalReceipt

  it('reprints one collapsed line', () => {
    const d = reprintReceiptData(rec())!
    expect(d.lines).toHaveLength(2)
    expect(d.lines[1].pieces).toHaveLength(3)
  })
  it('refunds the bundle whole: set:1 on three lines', () => {
    const order = localReceiptOrder(rec())
    const items = order.items as unknown as Array<{ refundGroup: string | null; bundleGroup?: number }>
    expect(items.map((i) => i.refundGroup)).toEqual([null, 'set:1', 'set:1', 'set:1'])
    expect(items.slice(1).every((i) => i.bundleGroup === 1)).toBe(true)
    const basis = buildRefundBasis(order)
    if (basis.kind !== 'lines') throw new Error('lines')
    expect(basis.lines.filter((l) => l.group === 'set:1')).toHaveLength(3)
  })
})

function slipText(u: Uint8Array): string[] {
  const out: number[] = []
  for (let i = 0; i < u.length; i++) {
    const c = u[i]!
    if (c === 0x1b) { i += u[i + 1] === 0x40 ? 1 : 2; continue }
    if (c === 0x1d) { i += u[i + 1] === 0x56 ? 3 : 2; continue }
    out.push(c)
  }
  return String.fromCharCode(...out).split('\n').slice(0, -1)
}
