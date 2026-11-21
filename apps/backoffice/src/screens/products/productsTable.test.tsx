import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Product } from '@mandalika/api'
import { ProductsTable } from './ProductsTable'

const noop = () => {}
const base = {
  id: 'p1', name: 'Melati', brand: 'Mandalika', categoryId: 'c1', isActive: true,
  variants: [{ id: 'v1', size: '30 ml', price: 100000, stock: 5, sku: 'M-30' }],
} as unknown as Product

const render = (p: Product) =>
  renderToStaticMarkup(<ProductsTable rows={[p]} catName={() => 'Parfum'} loading={false} onEdit={noop} onDelete={noop} />)

describe('ProductsTable status cell (M-8)', () => {
  it('shows the switch plus one state word, with no second status badge', () => {
    const html = render(base)
    expect(html).toContain('role="switch"')
    expect((html.match(/>Aktif</g) ?? []).length).toBe(1)
    expect(html).not.toContain('bg-paper-1 text-ink-700 rounded-lg')
  })

  it('says Nonaktif for an inactive product', () => {
    expect(render({ ...base, isActive: false })).toContain('>Nonaktif<')
  })

  it('tags an ERP product with a neutral source tag and gives the disabled delete its reason as the title', () => {
    const html = render({ ...base, erpLinked: true })
    expect(html).toContain('Dari ERP')
    const del = (html.match(/<button[^>]*aria-label="Hapus Melati"[^>]*>/) ?? [''])[0]
    expect(del).toMatch(/\sdisabled(=|\s|>)/)
    expect(del).toContain('title="Produk dari ERP tidak bisa dihapus; nonaktifkan saja"')
  })

  it('labels the row actions', () => {
    const html = render(base)
    expect(html).toContain('aria-label="Ubah Melati"')
  })
})

describe('ProductsTable stock chips (many sizes)', () => {
  const SIZES = ['100ml EXTRAIT DE PARFUM', '100ml PARFUM INTENSE', '10ml ATOMIZER', '120ml EXTRAIT DE PARFUM', '120ml PARFUM INTENSE', '15g', '30ml', '50ml V2', '110ml EXTRAIT DE PARFUM']
  const withSizes = (n: number, stock: (i: number) => number = () => 0) =>
    ({ ...base, variants: SIZES.slice(0, n).map((size, i) => ({ id: `v${i}`, size, price: 1, stock: stock(i), sku: `S${i}` })) }) as unknown as Product

  it('shows two sizes plus one "+N varian" chip that counts the hidden habis sizes', () => {
    const html = render(withSizes(9))
    expect(html).toContain('100ml EXTRAIT DE PARFUM: ')
    expect(html).toContain('100ml PARFUM INTENSE: ')
    expect(html).toContain('+7 varian (7 habis)')
    // The hidden sizes stay readable: tooltip and screen-reader text list them.
    expect(html).toContain('title="10ml ATOMIZER: Habis, ')
    expect(html).toContain('<span class="sr-only">: 10ml ATOMIZER: Habis')
  })

  it('counts low and out separately and stays neutral wording when every hidden size is fine', () => {
    expect(render(withSizes(6, (i) => (i === 3 ? 0 : i === 4 ? 2 : 10)))).toContain('+4 varian (1 habis, 1 rendah)')
    expect(render(withSizes(5, () => 10))).toContain('+3 varian<')
  })

  it('shows every chip when a product has three sizes or fewer', () => {
    const html = render(withSizes(3))
    expect(html).toContain('10ml ATOMIZER: ')
    expect(html).not.toContain('varian')
  })

  it('wraps the chips inside the column instead of forcing one line', () => {
    expect(render(withSizes(9))).toContain('class="flex flex-wrap gap-1 py-1.5"')
  })

  it('keeps a single-unit product as one "Stok: Habis" chip', () => {
    const html = render({ ...base, variants: [{ id: 'v1', size: 'Satuan', price: 1, stock: 0, sku: 'X' }] } as unknown as Product)
    expect(html).toContain('>Stok: Habis<')
    expect(html).not.toContain('varian')
  })
})
