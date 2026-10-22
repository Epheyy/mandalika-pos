import { SINGLE_UNIT_SIZE } from '@mandalika/types'
import type { Form } from './types'

/**
 * Client-side checks before a product save; returns the first error message or null.
 * ERP-linked products keep their ERP-owned category (it may be empty), and an ERP
 * variant may stay at price 0 (a discontinued or never-priced item); every other
 * variant needs a price.
 */
export function validateProductForm(form: Form): string | null {
  if (!form.name.trim()) return 'Nama produk wajib diisi'
  if (!form.categoryId && !form.erpLinked) return 'Pilih kategori'
  // A single-variant product (e.g. merch like a bag) may leave Ukuran blank →
  // it defaults to "Satuan". Multi-variant products need a distinct, non-empty
  // size on each row.
  const single = form.variants.length === 1
  const variants = form.variants.map((v) => ({
    ...v,
    size: v.size.trim() || (single ? SINGLE_UNIT_SIZE : ''),
  }))
  if (variants.some((v) => !v.erpSlug && v.price <= 0)) return 'Setiap varian harus punya harga'
  if (variants.some((v) => !v.sku.trim())) return 'Setiap varian wajib punya SKU'
  if (!single && variants.some((v) => !v.size))
    return 'Produk dengan beberapa varian: setiap varian wajib punya ukuran'
  if (!single) {
    const sizes = variants.map((v) => v.size.toLowerCase())
    if (new Set(sizes).size !== sizes.length) return 'Ukuran varian tidak boleh sama'
  }
  return null
}
