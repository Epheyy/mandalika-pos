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

export interface CartLineLike { productId: string; variantSize: string; quantity: number }

/** SP-CRM-9c: lines whose quantity exceeds the (pending-adjusted) available
 *  stock. Used only to WARN — never to block. Empty when allowNegative is true.
 *  Aggregates quantities across all lines sharing the same productId|variantSize
 *  before comparing, so a paid line + reward line for the same SKU are evaluated
 *  together rather than independently. */
export function overstockLines(
  cart: CartLineLike[],
  stockProducts: Product[],
  allowNegative: boolean,
): CartLineLike[] {
  if (allowNegative) return []
  const totals = new Map<string, number>()
  for (const line of cart) {
    const key = `${line.productId}|${line.variantSize}`
    totals.set(key, (totals.get(key) ?? 0) + line.quantity)
  }
  const result: CartLineLike[] = []
  for (const [key, totalQty] of totals) {
    const [productId, variantSize] = key.split('|')
    const st = stockFor(stockProducts, productId, variantSize)
    if (st !== null && totalQty > st) {
      result.push({ productId, variantSize, quantity: totalQty })
    }
  }
  return result
}

/** A44 (owner decision 2026-10-16): selling past the system stock is never blocked. */
export const OVERSELL_WARNING = 'Stok habis — tetap ditambahkan, dicatat sebagai stok minus'

/** Variant popup +/-: quantity floors at zero and is NOT capped by stock. */
export function nextVariantQty(prev: number, delta: number): number {
  return Math.max(0, prev + delta)
}

/** True when adding `add` units on top of `inCart` passes `stock` (stock may be <= 0). */
export function exceedsStock(inCart: number, add: number, stock: number): boolean {
  return add > 0 && inCart + add > stock
}

/** Sizes in `variantQtys` (qty > 0) that pass their stock once added to what the cart holds. */
export function oversoldSizes(
  product: Product,
  variantQtys: Record<string, number>,
  cartQtyFor: (size: string) => number,
): string[] {
  return product.variants
    .filter((v) => exceedsStock(cartQtyFor(v.size), variantQtys[v.size] ?? 0, v.stock))
    .map((v) => v.size)
}
