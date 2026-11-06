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
