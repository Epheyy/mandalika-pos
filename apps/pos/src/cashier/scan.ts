import type { components } from '@mandalika/api'

type Product = components['schemas']['Product']
type ProductVariant = components['schemas']['ProductVariant']

export interface ScanMatch {
  product: Product
  variant: ProductVariant
}

/** Build an exact-match index from synced products: barcode → {product,variant}.
 *  First occurrence wins (barcodes are catalog-wide unique server-side). */
export function buildScanIndex(products: Product[]): Map<string, ScanMatch> {
  const index = new Map<string, ScanMatch>()
  for (const product of products) {
    for (const variant of product.variants) {
      const key = (variant.barcode ?? '').trim()
      if (key && !index.has(key)) index.set(key, { product, variant })
    }
  }
  return index
}

/** Resolve a scanned/typed code to a variant via exact (trimmed) match. */
export function resolveScan(
  index: Map<string, ScanMatch>,
  code: string,
): ScanMatch | null {
  return index.get(code.trim()) ?? null
}
