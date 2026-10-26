import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Category, Outlet, Product, ProductVariant } from '@mandalika/api'
import { VariantRows } from './VariantRows'
import { ProductsTable } from './ProductsTable'
import { ProductFormModal } from './ProductFormModal'
import { OutletFormModal } from '../inventory/OutletFormModal'
import { EMPTY } from './types'
import { validateProductForm } from './validateForm'
import type { Form } from './types'

// ERP-owned fields are read-only on linked rows (plan 4.5): the static markup of the
// real components shows which controls are disabled and which badges are present.
// Mapping v3 (2026-10-26): product name/category and outlet name/address/phone are
// POS-owned and stay editable on linked rows; variant size/SKU, removal and delete stay locked.

const noop = () => {}
const linkedVariant: ProductVariant = { id: 'v1', size: '50 ml', price: 100000, stock: 0, sku: 'ZE-50', barcode: 'BC', erpSlug: 'slug-50', isActive: true }
const inactiveVariant: ProductVariant = { id: 'v2', size: '100 ml', price: 180000, stock: 0, sku: 'ZE-100', barcode: 'BC2', erpSlug: 'slug-100', isActive: false }
const plainVariant: ProductVariant = { id: 'v3', size: '30 ml', price: 50000, stock: 0, sku: 'ZE-30', barcode: 'BC3' }

// The <input ...> tag that carries the given aria-label, for the variant row at index.
function inputTag(html: string, label: string, index = 0): string {
  const tags = html.match(/<input[^>]*>/g) ?? []
  return tags.filter((t) => t.includes(`aria-label="${label}"`))[index] ?? ''
}
const isDisabled = (tag: string) => /\sdisabled(=|\s|>)/.test(tag)

function variantRows(variants: ProductVariant[]) {
  return renderToStaticMarkup(
    <VariantRows variants={variants} editing recipesEnabled={false} recipeVariantIds={new Set()} productName="P"
      onAddVariant={noop} onUpdVariant={noop} onRemoveVariant={noop} setRecipeFor={noop} />,
  )
}

describe('VariantRows with ERP-linked variants', () => {
  it('locks size and SKU, keeps price and barcode editable, and shows the ERP badge instead of the remove button', () => {
    const html = variantRows([linkedVariant, plainVariant])
    expect(isDisabled(inputTag(html, 'Ukuran varian', 0))).toBe(true)
    expect(isDisabled(inputTag(html, 'SKU varian', 0))).toBe(true)
    expect(isDisabled(inputTag(html, 'Harga dasar varian', 0))).toBe(false)
    expect(isDisabled(inputTag(html, 'Barcode varian', 0))).toBe(false)
    expect(html).toContain('title="Varian dari ERP tidak bisa dihapus"')
    // the unlinked variant stays fully editable and keeps its remove button
    expect(isDisabled(inputTag(html, 'Ukuran varian', 1))).toBe(false)
    expect(isDisabled(inputTag(html, 'SKU varian', 1))).toBe(false)
    expect((html.match(/hover:text-red-500/g) ?? []).length).toBe(1) // only the unlinked row keeps a remove button
  })

  it('labels an inactive linked variant "Nonaktif (ERP)" and nothing else', () => {
    expect(variantRows([linkedVariant, inactiveVariant])).toContain('Nonaktif (ERP)')
    expect(variantRows([linkedVariant, plainVariant])).not.toContain('Nonaktif (ERP)')
  })

  it('leaves a product without ERP variants untouched', () => {
    const html = variantRows([plainVariant])
    expect(html).not.toContain('ERP')
    expect(isDisabled(inputTag(html, 'Ukuran varian'))).toBe(false)
  })
})

function table(products: Product[]) {
  return renderToStaticMarkup(
    <ProductsTable loading={false} filtered={products} categories={[]} search="" setSearch={noop} fCat="" setFCat={noop}
      catName={() => 'Floral'} onEdit={noop} onDelete={noop} />,
  )
}
const product = (over: Partial<Product>): Product => ({
  id: 'p', name: 'Melati', brand: 'Mandalika', categoryId: 'c', variants: [plainVariant],
  isFeatured: false, isFavourite: false, isActive: true, createdAt: '2026-10-22T00:00:00Z', ...over,
})

describe('ProductsTable ERP badge and delete', () => {
  it('shows "Dari ERP" and disables delete for a linked product only', () => {
    const linked = table([product({ erpLinked: true })])
    expect(linked).toContain('Dari ERP')
    expect(isDisabled(linked.match(/<button[^>]*title="Produk dari ERP[^>]*>/)?.[0] ?? '')).toBe(true)
    const plain = table([product({})])
    expect(plain).not.toContain('Dari ERP')
    expect(plain).not.toContain('Produk dari ERP tidak bisa dihapus')
    const deleteTag = (plain.match(/<button[^>]*>/g) ?? []).filter((t) => t.includes('hover:bg-red-50'))[0] ?? ''
    expect(deleteTag).not.toBe('')
    expect(isDisabled(deleteTag)).toBe(false)
  })
})

function formModal(form: Form) {
  const categories: Category[] = [{ id: 'c', name: 'Floral' }]
  return renderToStaticMarkup(
    <ProductFormModal open onClose={noop} editing busy={false} err={null} onSave={noop} form={form} setForm={noop}
      categories={categories} uploading={false} onImage={noop} removeImage={noop} makeMainImage={noop}
      recipesEnabled={false} recipeVariantIds={new Set()} onUpdVariant={noop} onAddVariant={noop} onRemoveVariant={noop}
      setRecipeFor={noop} ocfgLoading={false} ocfgOutlets={[]} ocGet={() => ({ price: null, available: true })} ocSet={noop}
      setOutletAllAvailable={noop} basePriceOf={() => 0} ocCollapsed={{}} setOcCollapsed={noop} />,
  )
}

describe('ProductFormModal for an ERP-linked product', () => {
  const linked: Form = { ...EMPTY, name: 'Melati', categoryId: 'c', variants: [linkedVariant], erpLinked: true, erpGroupKey: 'grp-melati' }

  it('shows the origin line and leaves name, category, brand, description and the flags editable', () => {
    const html = formModal(linked)
    expect(html).toContain('Dari ERP')
    expect(html).toContain('grp-melati')
    expect(html).not.toContain('erp-hint-name')
    expect(html).not.toContain('erp-hint-category')
    const inputs = html.match(/<input[^>]*>/g) ?? []
    const nameInput = inputs.find((t) => t.includes('value="Melati"')) ?? ''
    const brandInput = inputs.find((t) => t.includes('value="Mandalika"')) ?? ''
    expect(nameInput).not.toBe('')
    expect(isDisabled(nameInput)).toBe(false)
    expect(isDisabled(brandInput)).toBe(false)
    expect(isDisabled((html.match(/<select[^>]*>/) ?? [''])[0])).toBe(false)
    expect(isDisabled((html.match(/<textarea[^>]*>/) ?? [''])[0])).toBe(false)
    for (const t of inputs.filter((x) => x.includes('type="checkbox"'))) expect(isDisabled(t)).toBe(false)
  })

  it('shows nothing ERP-related for an unlinked product', () => {
    const html = formModal({ ...EMPTY, name: 'Melati', categoryId: 'c', variants: [plainVariant] })
    expect(html).not.toContain('Dari ERP')
    expect(html).not.toContain('Dikelola ERP')
    expect(isDisabled((html.match(/<select[^>]*>/) ?? [''])[0])).toBe(false)
  })
})

const outlet = (over: Partial<Outlet>): Outlet => ({
  id: 'o', name: 'Outlet ERP', code: 'ZE1', address: 'Jl. ERP 1', phone: '0812', isActive: true,
  timezone: 'Asia/Jakarta', createdAt: '2026-10-22T00:00:00Z', ...over,
})

describe('OutletFormModal for an ERP-linked outlet', () => {
  it('shows the ERP code and keeps name, address, phone and code editable', () => {
    const html = renderToStaticMarkup(<OutletFormModal editing={outlet({ erpSlug: 'slug-o', erpCode: 'ERP-01' })} onClose={noop} onDone={noop} />)
    expect(html).toContain('Kode ERP')
    expect(html).toContain('ERP-01')
    const inputs = html.match(/<input[^>]*>/g) ?? []
    expect(html).not.toContain('Dikelola ERP')
    expect(isDisabled(inputs.find((t) => t.includes('value="Outlet ERP"')) ?? 'disabled')).toBe(false)
    expect(isDisabled(inputs.find((t) => t.includes('type="tel"')) ?? 'disabled')).toBe(false)
    expect(isDisabled((html.match(/<textarea[^>]*>/) ?? ['disabled'])[0])).toBe(false)
    expect(isDisabled(inputs.find((t) => t.includes('value="ZE1"')) ?? 'disabled')).toBe(false)
  })

  it('leaves an unlinked outlet fully editable', () => {
    const html = renderToStaticMarkup(<OutletFormModal editing={outlet({})} onClose={noop} onDone={noop} />)
    expect(html).not.toContain('Kode ERP')
    expect(html).not.toContain('Dikelola ERP')
    expect(isDisabled((html.match(/<textarea[^>]*>/) ?? [''])[0])).toBe(false)
  })
})

describe('validateProductForm for ERP rows', () => {
  const zero: ProductVariant = { ...linkedVariant, price: 0 }
  it('lets an ERP-linked product without a category save', () => {
    const f: Form = { ...EMPTY, name: 'Melati', categoryId: '', variants: [linkedVariant], erpLinked: true }
    expect(validateProductForm(f)).toBeNull()
    expect(validateProductForm({ ...f, erpLinked: false })).toBe('Pilih kategori')
  })
  it('lets an ERP variant stay at price 0 but still requires a price on unlinked variants', () => {
    const f: Form = { ...EMPTY, name: 'Melati', categoryId: 'c', variants: [zero, plainVariant], erpLinked: true }
    expect(validateProductForm(f)).toBeNull()
    expect(validateProductForm({ ...f, variants: [zero, { ...plainVariant, price: 0 }] })).toBe('Setiap varian harus punya harga')
  })
})
