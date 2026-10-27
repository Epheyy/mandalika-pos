import type { components } from '@mandalika/api'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'sheet-title' }))

import { LineSheet } from './LineSheet'
import { sizeOptions } from './lineSizes'
import { formatRupiah } from './pricing'

type Product = components['schemas']['Product']

const product = {
  id: 'p1', name: 'Oud', isActive: true, brand: '', categoryId: '', createdAt: '',
  variants: [
    { size: '50ml', price: 350000, stock: 9, sku: 'A' },
    { size: '110ml', price: 520000, stock: 0, sku: 'B' },
  ],
} as unknown as Product
const line = { productId: 'p1', productName: 'Oud', variantSize: '50ml', price: 350000, quantity: 2, subtotal: 700000 }
const noop = () => {}
const base = { sizes: sizeOptions(product, '50ml'), hasOrderNotes: false, onSetQty: noop, onRemove: noop, onSwitchSize: noop, onOpenNotes: noop, onClose: noop }

function collect(node: unknown, pred: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const el = node as ReactElement<{ children?: unknown }>
  if (pred(el)) out.push(el)
  collect(el.props.children, pred, out)
  return out
}
type Clickable = ReactElement<{ onClick?: () => void; selected?: boolean; onDecrement?: () => void; onIncrement?: () => void; children?: unknown; 'aria-label'?: string }>
/** Unrendered tree: Chip, Button and Stepper stay as component elements; plain buttons by aria-label. */
const controls = (props: Record<string, unknown>): Clickable[] => {
  const tree = LineSheet({ ...base, line, ...props } as never) as ReactElement<{ children: unknown }>
  return collect(tree.props.children, (el) => typeof el.type !== 'string' || el.type === 'button') as Clickable[]
}
const named = (list: Clickable[], text: string) =>
  list.find((el) => el.props['aria-label'] === text || (Array.isArray(el.props.children) ? el.props.children.join('') : el.props.children) === text)

describe('LineSheet (B1)', () => {
  it('renders nothing without a line', () => {
    expect(renderToStaticMarkup(createElement(LineSheet, { ...base, line: null }))).toBe('')
  })

  it('shows name, size, unit price, quantity, subtotal, the other size as a chip, Catatan and Hapus', () => {
    const html = renderToStaticMarkup(createElement(LineSheet, { ...base, line }))
    expect(html).toContain('Oud')
    expect(html).toContain('50ml · ')
    expect(html).toContain(`${formatRupiah(350000)} / unit`)
    expect(html).toContain(formatRupiah(700000))
    expect(html).toContain('aria-label="Kurangi"')
    expect(html).toContain('aria-label="Tambah"')
    // The current size is a static chip (no button), the other size a toggle button.
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain(`110ml · ${formatRupiah(520000)}`)
    expect(html).toContain('Habis')
    expect(html).toContain('Catatan')
    expect(html).toContain('Hapus')
    expect(html).toContain('aria-label="Tutup detail baris"')
  })

  it('hides the size switch for a single-size product', () => {
    const html = renderToStaticMarkup(createElement(LineSheet, { ...base, line, sizes: [] }))
    expect(html).not.toContain('Ukuran')
  })

  it('wires the stepper to onSetQty with the cart rule (decrement at 1 asks for 0)', () => {
    const onSetQty = vi.fn()
    const stepper = controls({ onSetQty, line: { ...line, quantity: 1 } }).find((el) => el.props.onDecrement)!
    stepper.props.onDecrement!()
    stepper.props.onIncrement!()
    expect(onSetQty.mock.calls).toEqual([[0], [2]])
  })

  it('a non-current size chip calls onSwitchSize; the current one is not tappable', () => {
    const onSwitchSize = vi.fn()
    const chips = controls({ onSwitchSize }).filter((el) => 'selected' in el.props)
    expect(chips.map((c) => c.props.selected)).toEqual([true, false])
    expect(chips[0].props.onClick).toBeUndefined()
    chips[1].props.onClick!()
    expect(onSwitchSize).toHaveBeenCalledWith('110ml')
  })

  it('Hapus, Catatan and the close control call their handlers', () => {
    const onRemove = vi.fn(), onOpenNotes = vi.fn(), onClose = vi.fn()
    const list = controls({ onRemove, onOpenNotes, onClose })
    named(list, 'Hapus')!.props.onClick!()
    named(list, 'Catatan')!.props.onClick!()
    named(list, 'Tutup')!.props.onClick!()
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onOpenNotes).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
