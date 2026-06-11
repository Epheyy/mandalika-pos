import type { components } from '@mandalika/api'

type Product = components['schemas']['Product']

/** SP-CRM-9c: return products with each variant's stock reduced by the pending
 *  (unsynced) sale quantity for that `${productId}|${size}`. Display may go
 *  negative so the cashier sees oversell. */
export function applyPendingStock(
  products: Product[],
  deltas: Record<string, number>,
): Product[] {
  return products.map((p) => ({
    ...p,
    variants: p.variants.map((v) => {
      const key = `${p.id ?? ''}|${v.size}`
      const d = deltas[key] ?? 0
      return d ? { ...v, stock: v.stock - d } : v
    }),
  }))
}

/** Stock for one product+size from a (already pending-adjusted) product list. */
export function stockFor(products: Product[], productId: string, size: string): number | null {
  const p = products.find((x) => x.id === productId)
  if (!p) return null
  const v = p.variants.find((x) => x.size === size)
  return v ? v.stock : null
}
