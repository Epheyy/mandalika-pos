import type { Product } from '@mandalika/api'
import { lineKey } from './requisitionFlow'

export interface VariantOption {
  key: string
  productId: string
  productName: string
  variantSize: string
  sku: string
  /** Outlet stock as the tablet shows it (pending sales applied). */
  stock: number
}

const MAX_OPTIONS = 50

/** Picker rows over the tablet's cached catalog: active products and variants only, matched on name, SKU or size. */
export function variantOptions(products: readonly Product[], search: string, limit = MAX_OPTIONS): VariantOption[] {
  const q = search.trim().toLowerCase()
  const out: VariantOption[] = []
  for (const p of products) {
    if (!p.id || !p.isActive) continue
    for (const v of p.variants) {
      if (v.isActive === false) continue
      const sku = v.sku ?? ''
      if (q && !p.name.toLowerCase().includes(q) && !sku.toLowerCase().includes(q) && !v.size.toLowerCase().includes(q)) continue
      out.push({ key: lineKey({ productId: p.id, variantSize: v.size }), productId: p.id, productName: p.name, variantSize: v.size, sku, stock: v.stock })
      if (out.length >= limit) return out
    }
  }
  return out
}
