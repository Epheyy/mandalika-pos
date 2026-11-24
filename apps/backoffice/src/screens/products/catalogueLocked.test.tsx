import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Category, Product, ProductVariant } from '@mandalika/api'
import { ProductFormSlideOver } from './ProductFormSlideOver'
import { ProductsTable } from './ProductsTable'
import { CategoriesTable } from './CategoriesTable'
import { CATALOGUE_LOCKED_NOTE } from './CatalogueLockedNote'
import { NOTHING_TO_SAVE, outletConfigItems, persistProduct } from './productSave'
import { EMPTY } from './types'
import type { Form } from './types'

// A covered-only Manajer sees the catalogue view-only: shared fields disabled, the per-outlet section editable,
// and Simpan writes only the outlet config (the server answers PUT /products/{id} with 403).

const noop = () => {}
const variant: ProductVariant = { id: 'v1', size: '50 ml', price: 100000, stock: 0, sku: 'M-50', barcode: 'BC' }
const form: Form = { ...EMPTY, name: 'Melati', categoryId: 'c', images: ['https://img/1.png', 'https://img/2.png'], variants: [variant] }
const NOTE = 'Katalog hanya bisa diubah oleh admin atau Manajer Semua Outlet.'

const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag)
const tagsOf = (html: string, name: string) => html.match(new RegExp(`<${name}[^>]*>`, 'g')) ?? []

function editor(catalogueLocked: boolean) {
  const categories: Category[] = [{ id: 'c', name: 'Floral' }]
  return renderToStaticMarkup(
    <ProductFormSlideOver catalogueLocked={catalogueLocked} onClose={noop} editing load="ready" loadError={null} dirty={false} busy={false} err={null} errors={[]} onSave={noop}
      form={form} setForm={noop} categories={categories} uploading={false} onImage={noop} removeImage={noop} makeMainImage={noop}
      recipesEnabled={false} recipeVariantIds={new Set()} onUpdVariant={noop} onAddVariant={noop} onRemoveVariant={noop}
      setRecipeFor={noop} ocfgLoading={false} ocfgOutlets={[{ id: 'o1', name: 'BSD' }]} ocGet={() => ({ price: null, available: true })} ocSet={noop}
      setOutletAllAvailable={noop} basePriceOf={() => 100000} ocCollapsed={{}} setOcCollapsed={noop} />,
  )
}

describe('ProductFormSlideOver with a locked catalogue', () => {
  const html = editor(true)
  const labelled = (label: string) => tagsOf(html, 'input').filter((t) => t.includes(`aria-label="${label}"`))

  it('disables every shared field and shows the note', () => {
    expect(html).toContain(NOTE)
    expect(CATALOGUE_LOCKED_NOTE).toBe(NOTE)
    const inputs = tagsOf(html, 'input')
    expect(isDisabled(inputs.find((t) => t.includes('value="Melati"')) ?? '')).toBe(true)
    expect(isDisabled(inputs.find((t) => t.includes('value="Mandalika"')) ?? '')).toBe(true)
    expect(isDisabled(tagsOf(html, 'select')[0] ?? '')).toBe(true)
    expect(isDisabled(tagsOf(html, 'textarea')[0] ?? '')).toBe(true)
    for (const label of ['Ukuran varian', 'SKU varian', 'Barcode varian', 'Harga dasar varian']) {
      expect(isDisabled(labelled(label)[0] ?? '')).toBe(true)
    }
    const flags = inputs.filter((t) => t.includes('type="checkbox"') && !t.includes('aria-label') && !t.includes('id='))
    expect(flags.length).toBe(2)
    for (const t of flags) expect(isDisabled(t)).toBe(true)
    const activeSwitch = tagsOf(html, 'button').find((t) => t.includes('aria-label="Produk Aktif"')) ?? ''
    expect(isDisabled(activeSwitch)).toBe(true)
  })

  it('has no photo upload, remove, make-main, add-variant or remove-variant control', () => {
    expect(html).not.toContain('Hapus foto')
    expect(html).not.toContain('Jadikan utama')
    expect(html).not.toContain('Unggah foto produk')
    expect(html).not.toContain('Tambah varian')
    expect(html).not.toContain('Hapus varian')
  })

  it('keeps the per-outlet price and availability inputs enabled', () => {
    const inputs = tagsOf(html, 'input')
    const avail = inputs.find((t) => t.includes('aria-label="Jual 50 ml di outlet ini"')) ?? ''
    const price = inputs.find((t) => t.includes('aria-label="Harga 50 ml di outlet ini"')) ?? ''
    const all = inputs.find((t) => t.includes('id="outlet-config-all-0"')) ?? ''
    for (const t of [avail, price, all]) {
      expect(t).not.toBe('')
      expect(isDisabled(t)).toBe(false)
    }
  })
})

describe('ProductFormSlideOver with an unlocked catalogue', () => {
  const html = editor(false)
  it('is unchanged: no note, fields enabled, upload and variant controls present', () => {
    expect(html).not.toContain(NOTE)
    const inputs = tagsOf(html, 'input')
    expect(isDisabled(inputs.find((t) => t.includes('value="Melati"')) ?? 'disabled')).toBe(false)
    expect(isDisabled(tagsOf(html, 'select')[0] ?? '')).toBe(false)
    expect(isDisabled(tagsOf(html, 'textarea')[0] ?? '')).toBe(false)
    expect(html).toContain('Hapus foto')
    expect(html).toContain('Unggah foto produk')
    expect(html).toContain('Tambah varian')
  })
})

const product = { id: 'p', name: 'Melati', brand: 'Mandalika', categoryId: 'c', variants: [variant], isFeatured: false, isFavourite: false, isActive: true, createdAt: '2026-10-22T00:00:00Z' } as Product

describe('list tables with a locked catalogue', () => {
  it('ProductsTable drops Hapus but keeps the row open to the editor', () => {
    const locked = renderToStaticMarkup(<ProductsTable rows={[product]} catName={() => 'Floral'} loading={false} onEdit={noop} onDelete={noop} catalogueLocked />)
    expect(locked).not.toContain('Hapus Melati')
    expect(locked).toContain('Ubah Melati')
    const open = renderToStaticMarkup(<ProductsTable rows={[product]} catName={() => 'Floral'} loading={false} onEdit={noop} onDelete={noop} />)
    expect(open).toContain('Hapus Melati')
  })

  it('CategoriesTable drops edit and delete', () => {
    const cat: Category = { id: 'c', name: 'Floral' }
    const locked = renderToStaticMarkup(<CategoriesTable categories={[cat]} counts={{}} onEdit={noop} onDelete={noop} catalogueLocked />)
    expect(locked).not.toContain('Hapus Floral')
    expect(locked).not.toContain('Ubah Floral')
    const open = renderToStaticMarkup(<CategoriesTable categories={[cat]} counts={{}} onEdit={noop} onDelete={noop} />)
    expect(open).toContain('Hapus Floral')
  })
})

describe('saving a product from the editor', () => {
  const outlets = [{ id: 'o1', name: 'BSD' }]
  const items = outletConfigItems(outlets, [variant], { 'o1|50 ml': { price: 90000, available: false } })
  const body = { name: 'Melati' } as never
  const client = () => ({ createProduct: vi.fn(), updateProduct: vi.fn(), updateProductOutletConfig: vi.fn() })

  it('builds one item per outlet and sized variant from the matrix', () => {
    expect(items).toEqual([{ outletId: 'o1', variantSize: '50 ml', price: 90000, available: false }])
  })

  it('locked: calls updateProductOutletConfig and never updateProduct or createProduct', async () => {
    const c = client()
    await persistProduct(c, { productId: 'p1', catalogueLocked: true, body, items, hasOutlets: true })
    expect(c.updateProductOutletConfig).toHaveBeenCalledWith('p1', items)
    expect(c.updateProduct).not.toHaveBeenCalled()
    expect(c.createProduct).not.toHaveBeenCalled()
  })

  it('locked with no outlets: writes nothing and says so instead of closing as saved', async () => {
    const c = client()
    await expect(persistProduct(c, { productId: 'p1', catalogueLocked: true, body, items: [], hasOutlets: false }))
      .rejects.toThrow(NOTHING_TO_SAVE)
    await expect(persistProduct(c, { productId: null, catalogueLocked: true, body, items, hasOutlets: true }))
      .rejects.toThrow(NOTHING_TO_SAVE)
    expect(c.updateProductOutletConfig).not.toHaveBeenCalled()
    expect(c.updateProduct).not.toHaveBeenCalled()
    expect(c.createProduct).not.toHaveBeenCalled()
  })

  it('unlocked: updates the product, then the outlet config', async () => {
    const c = client()
    await persistProduct(c, { productId: 'p1', catalogueLocked: false, body, items, hasOutlets: true })
    expect(c.updateProduct).toHaveBeenCalledWith('p1', body)
    expect(c.updateProductOutletConfig).toHaveBeenCalledWith('p1', items)
  })

  it('unlocked new product: creates only', async () => {
    const c = client()
    await persistProduct(c, { productId: null, catalogueLocked: false, body, items: [], hasOutlets: false })
    expect(c.createProduct).toHaveBeenCalledWith(body)
    expect(c.updateProduct).not.toHaveBeenCalled()
  })
})
