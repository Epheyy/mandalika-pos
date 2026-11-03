import { SINGLE_UNIT_SIZE } from '@mandalika/types'
import type { Form } from './types'

/** One problem in the product form, tied to the control that has to change. */
export interface ProductFormError {
  /** The control's id (the error summary focuses it). */
  fieldId: string
  /** Short field name for the summary: "Harga varian 2". */
  label: string
  /** The sentence shown under the control. */
  message: string
}

export const FIELD_ID = {
  name: 'product-name',
  category: 'product-category',
  size: (i: number) => `variant-size-${i}`,
  price: (i: number) => `variant-price-${i}`,
  sku: (i: number) => `variant-sku-${i}`,
} as const

/**
 * Client-side checks before a product save, in the order they are shown. ERP-linked products keep their
 * ERP-owned category (it may be empty), and an ERP variant may stay at price 0 (a discontinued or never-priced
 * item); every other variant needs a price. A single-variant product (e.g. a bag) may leave Ukuran blank: it
 * is saved as "Satuan". Multi-variant products need a distinct, non-empty size on each row.
 */
export function productFormErrors(form: Form): ProductFormError[] {
  const errors: ProductFormError[] = []
  if (!form.name.trim()) errors.push({ fieldId: FIELD_ID.name, label: 'Nama produk', message: 'Nama produk wajib diisi' })
  if (!form.categoryId && !form.erpLinked) errors.push({ fieldId: FIELD_ID.category, label: 'Kategori', message: 'Pilih kategori' })

  const single = form.variants.length === 1
  const variants = form.variants.map((v) => ({
    ...v,
    size: v.size.trim() || (single ? SINGLE_UNIT_SIZE : ''),
  }))
  const where = (i: number) => (single ? '' : ` ${i + 1}`)

  variants.forEach((v, i) => {
    if (!v.erpSlug && v.price <= 0) {
      errors.push({ fieldId: FIELD_ID.price(i), label: `Harga varian${where(i)}`, message: 'Setiap varian harus punya harga' })
    }
  })
  variants.forEach((v, i) => {
    if (!v.sku.trim()) errors.push({ fieldId: FIELD_ID.sku(i), label: `SKU varian${where(i)}`, message: 'Setiap varian wajib punya SKU' })
  })
  if (!single) {
    variants.forEach((v, i) => {
      if (!v.size) {
        errors.push({
          fieldId: FIELD_ID.size(i),
          label: `Ukuran varian${where(i)}`,
          message: 'Produk dengan beberapa varian: setiap varian wajib punya ukuran',
        })
      }
    })
    const seen = new Set<string>()
    variants.forEach((v, i) => {
      const key = v.size.toLowerCase()
      if (v.size && seen.has(key)) {
        errors.push({ fieldId: FIELD_ID.size(i), label: `Ukuran varian${where(i)}`, message: 'Ukuran varian tidak boleh sama' })
      }
      seen.add(key)
    })
  }
  return errors
}

/** The first error's message, or null when the form is fine. */
export function validateProductForm(form: Form): string | null {
  return productFormErrors(form)[0]?.message ?? null
}
