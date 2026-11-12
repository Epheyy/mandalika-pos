import type { components } from '@mandalika/api'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'sheet-title' }))

import { BundleButtons } from './BundleButtons'
import { BundleCartLine } from './BundleCartLine'
import { BundleListSheet } from './BundleListSheet'
import { BundleSwapSheet } from './BundleSwapSheet'
import { advanceSwapFlow, buildBundleLines, swapTitle, type BundleOffer } from './setBundles'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const EXT = 'EXTRAIT DE PARFUM'
const v = (size: string, price: number, stock = 10) => ({ size, price, stock, sku: size })
const prod = (id: string, name: string, variants: Product['variants']): Product =>
  ({ id, name, brand: 'b', categoryId: 'c', variants, isFeatured: false, isFavourite: false }) as Product
const champion = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000, 5), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
const mk = (over: Partial<BundleOffer> = {}): BundleOffer => ({
  line: EXT, lineLabel: 'Extrait', lineShort: 'EXT', size: '120ml', price: 850000,
  largeVariantSize: '120ml EXTRAIT', atomizerVariantSize: '10ml ATOMIZER', vialVariantSize: '2ml EXTRAIT', ...over,
})
const render = (el: ReactElement) => renderToStaticMarkup(el)
const buttons = (offers: BundleOffer[], products = [champion], cart: CartItem[] = []) =>
  createElement(BundleButtons, { productId: 'champ', offers, products, cart, onTap: () => {}, onOpenList: () => {}, onSingles: () => {} })

function collect(node: unknown, pred: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as ReactElement<{ children?: unknown }>
  if (pred(el)) out.push(el)
  collect(el.props.children, pred, out)
  return out
}

describe('BundleButtons', () => {
  it('one offer renders one gold button with name, price and pieces', () => {
    const html = render(buttons([mk()]))
    expect(html.match(/<button/g)).toHaveLength(2) // the bundle + the Satuan link
    expect(html).toContain('Bundle EXT 120ml')
    expect(html).toContain('Rp')
    expect(html).toContain('850.000')
    expect(html).toContain('120ml + atomizer 10ml + 2ml')
    expect(html).toContain('bg-brand-strong')
    expect(html).toContain('Satuan (pilih ukuran)')
  })
  it('two offers render two buttons', () => {
    const html = render(buttons([mk(), mk({ line: 'PARFUM INTENSE', lineShort: 'PI', price: 795000 })]))
    expect(html).toContain('Bundle EXT 120ml')
    expect(html).toContain('Bundle PI 120ml')
    expect(html.match(/<button/g)).toHaveLength(3)
  })
  it('a line-less offer reads "Bundle 110ml"', () => {
    expect(render(buttons([mk({ line: '', lineShort: '', size: '110ml' })]))).toContain('Bundle 110ml')
  })
  it('four offers render one "Bundle · 4 pilihan" button that opens the list', () => {
    const offers = [mk({ size: '100ml', price: 650000 }), mk(), mk({ line: 'PARFUM INTENSE', lineShort: 'PI', size: '100ml' }), mk({ line: 'PARFUM INTENSE', lineShort: 'PI' })]
    const onOpenList = vi.fn()
    const tree = BundleButtons({ productId: 'champ', offers, products: [champion], cart: [], onTap: () => {}, onOpenList, onSingles: () => {} })
    const html = render(createElement(BundleButtons, { productId: 'champ', offers, products: [champion], cart: [], onTap: () => {}, onOpenList, onSingles: () => {} }))
    expect(html).toContain('Bundle · 4 pilihan')
    expect(html).toContain('mulai')
    expect(html).toContain('650.000')
    expect(html.match(/<button/g)).toHaveLength(2)
    const open = collect(tree, (el) => 'onOpenList' in (el.props as object))[0] as ReactElement<{ onOpenList: (e: { stopPropagation: () => void }) => void }>
    open.props.onOpenList({ stopPropagation: () => {} })
    expect(onOpenList).toHaveBeenCalledTimes(1)
  })
  it('a sold-out offer is disabled with Habis (stock counts the cart)', () => {
    const dry = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000, 0), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
    const html = render(buttons([mk()], [dry]))
    expect(html).toContain('disabled')
    expect(html).toContain('Habis')
    const one = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000, 1), v('10ml ATOMIZER', 250000), v('2ml EXTRAIT', 60000)])
    expect(render(buttons([mk()], [one]))).not.toContain('Habis')
    const cart: CartItem[] = [{ productId: 'champ', productName: 'CHAMPION', variantSize: '120ml EXTRAIT', price: 1, quantity: 1, subtotal: 1 }]
    expect(render(buttons([mk()], [one], cart))).toContain('Habis')
  })
  it('renders nothing without offers', () => {
    expect(render(buttons([]))).toBe('')
  })
})

describe('BundleListSheet', () => {
  it('lists offers grouped by line and greys a sold-out one', () => {
    const offers = [mk({ size: '100ml' }), mk(), mk({ line: 'PARFUM INTENSE', lineLabel: 'Parfum Intense', lineShort: 'PI', size: '120ml', price: 795000 })]
    const html = render(createElement(BundleListSheet, { product: champion, offers, products: [champion], cart: [], onPick: () => {}, onClose: () => {} }))
    expect(html).toContain('CHAMPION: pilih bundle')
    expect(html).toContain('Extrait')
    expect(html).toContain('Parfum Intense')
    expect(html).toContain('795.000')
  })
})

describe('BundleCartLine', () => {
  const lines = buildBundleLines(mk(), champion, [champion], 1).lines
  it('shows one bundle line with three pieces and two Ganti buttons', () => {
    const html = render(createElement(BundleCartLine, { lines, products: [champion], cart: lines, onSwap: () => {}, onRemove: () => {} }))
    expect(html).toContain('CHAMPION · Bundle EXT 120ml')
    expect(html).toContain('850.000')
    expect(html.match(/>Ganti</g)).toHaveLength(2)
    expect(html).toContain('10ml ATOMIZER')
    expect(html).toContain('2ml EXTRAIT')
    expect(html).not.toContain('Diskon Bundle')
  })
  it('marks a swapped piece and shows the Diskon Bundle row only when > 0', () => {
    const swapped = lines.map((l) => (l.bundleRole === 'atomizer' ? { ...l, productId: 'blue', productName: 'BLUE', bundleDiscount: 10 } : l))
    const blue = prod('blue', 'BLUE', [v('10ml ATOMIZER', 300000, 0)])
    const html = render(createElement(BundleCartLine, { lines: swapped, products: [champion, blue], cart: swapped, onSwap: () => {}, onRemove: () => {} }))
    expect(html).toContain('(diganti)')
    expect(html).toContain('Diskon Bundle')
    expect(html).toContain('Habis')
  })
  it('Ganti and remove call back with the role', () => {
    const onSwap = vi.fn()
    const onRemove = vi.fn()
    const tree = BundleCartLine({ lines, products: [champion], cart: lines, onSwap, onRemove })
    const bs = collect(tree, (el) => el.type === 'button') as ReactElement<{ onClick: () => void; children?: unknown }>[]
    bs.forEach((b) => b.props.onClick())
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onSwap.mock.calls.map((c) => c[0])).toEqual(['atomizer', 'vial'])
  })
})

describe('BundleSwapSheet', () => {
  const lines = buildBundleLines(mk(), champion, [champion], 1).lines
  const current = lines[1]
  const opt = { productId: 'blue', productName: 'BLUE', variantSize: '10ml ATOMIZER', price: 300000, stock: 4 }
  it('titles follow the copy table', () => {
    expect(swapTitle('atomizer', '')).toBe('Ganti atomizer 10ml')
    expect(swapTitle('vial', EXT)).toBe('Ganti 2ml Extrait')
    expect(swapTitle('vial', '')).toBe('Ganti 2ml')
  })
  it('shows the out-of-stock current piece as "Habis · stok akan minus" and keeping it calls onKeep', () => {
    const onKeep = vi.fn()
    const props = { role: 'atomizer' as const, line: EXT, current, options: [opt], currentSoldOut: true, onPick: () => {}, onKeep, onClose: () => {} }
    expect(render(createElement(BundleSwapSheet, props))).toContain('Habis · stok akan minus')
    const tree = BundleSwapSheet(props) as ReactElement<{ children: unknown }>
    const rows = collect(tree.props.children, (el) => el.type === 'button') as ReactElement<{ onClick: () => void }>[]
    rows[0].props.onClick()
    expect(onKeep).toHaveBeenCalled()
  })
  it('lists only the given options when the current piece is in stock; empty shows a note', () => {
    const base = { role: 'vial' as const, line: EXT, current, currentSoldOut: false, onPick: () => {}, onKeep: () => {}, onClose: () => {} }
    expect(render(createElement(BundleSwapSheet, { ...base, options: [opt] }))).not.toContain('Habis · stok akan minus')
    expect(render(createElement(BundleSwapSheet, { ...base, options: [] }))).toContain('Tidak ada pengganti')
  })
  it('stays closed without a role', () => {
    expect(render(createElement(BundleSwapSheet, { role: null, line: '', current: null, options: [], currentSoldOut: false, onPick: () => {}, onKeep: () => {}, onClose: () => {} }))).toBe('')
  })
})

describe('swap flow', () => {
  it('with atomizer and vial both out of stock, the vial sheet opens after the atomizer sheet closes', () => {
    const dry = prod('champ', 'CHAMPION', [v('120ml EXTRAIT', 1200000), v('10ml ATOMIZER', 250000, 0), v('2ml EXTRAIT', 60000, 0)])
    const built = buildBundleLines(mk(), dry, [dry], 1)
    expect(built.needsSwap).toEqual(['atomizer', 'vial'])
    const first = advanceSwapFlow(null) // nothing open: stays closed
    expect(first).toBeNull()
    const f0 = { group: 1, queue: built.needsSwap }
    const f1 = advanceSwapFlow(f0)
    expect(f1?.queue).toEqual(['vial'])
    expect(advanceSwapFlow(f1)).toBeNull()
  })
})
