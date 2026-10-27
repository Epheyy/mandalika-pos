import type { components } from '@mandalika/api'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'sheet-title' }))

import { VariantSheet } from './VariantSheet'
import { formatRupiah } from './pricing'

type Product = components['schemas']['Product']

const product = {
  id: 'p1', name: 'Oud', isActive: true, brand: '', categoryId: '', createdAt: '',
  variants: [
    { size: '50ml', price: 350000, stock: 9, sku: 'A' },
    { size: '110ml', price: 520000, stock: 0, sku: 'B' },
  ],
} as unknown as Product

/** Depth-first collect of elements matching `pred` in an unrendered React tree. */
function collect(node: unknown, pred: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as ReactElement<{ children?: unknown }>
  if (pred(el)) out.push(el)
  collect(el.props.children, pred, out)
  return out
}

describe('VariantSheet (B1, D-10)', () => {
  it('renders nothing without a product', () => {
    expect(renderToStaticMarkup(createElement(VariantSheet, { product: null, onPick: () => {}, onClose: () => {} }))).toBe('')
  })

  it('renders one tappable row per size with price and stock in the state colour, and no build-a-quantity controls', () => {
    const html = renderToStaticMarkup(createElement(VariantSheet, { product, onPick: () => {}, onClose: () => {} }))
    expect(html).toContain(`aria-label="Tambah 50ml · ${formatRupiah(350000)} · Stok 9"`)
    expect(html).toContain(`aria-label="Tambah 110ml · ${formatRupiah(520000)} · Habis"`)
    expect(html).toContain('text-ok')
    expect(html).toContain('text-danger')
    expect(html).toContain('min-h-14')
    expect(html).not.toContain('Tambah ke Keranjang')
    expect(html).not.toContain('aria-label="Kurangi"')
  })

  it('a row tap hands the product and that size to onPick (the caller adds one unit)', () => {
    const onPick = vi.fn()
    const tree = VariantSheet({ product, onPick, onClose: () => {} }) as ReactElement<{ children: unknown }>
    const rows = collect(tree.props.children, (el) => el.type === 'button')
    expect(rows).toHaveLength(2)
    ;(rows[1] as ReactElement<{ onClick: () => void }>).props.onClick()
    expect(onPick).toHaveBeenCalledWith(product, '110ml')
  })
})
