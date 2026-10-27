import type { components } from '@mandalika/api'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

export interface SizeOption {
  size: string
  price: number
  stock: number
  current: boolean
}

/** Every size of the line's product, in catalog order, with the line's own size flagged.
 *  Empty for an unknown or single-size product, so the line sheet offers no switch. */
export function sizeOptions(product: Product | undefined, currentSize: string): SizeOption[] {
  if (!product || product.variants.length < 2) return []
  return product.variants.map((v) => ({ size: v.size, price: v.price, stock: v.stock, current: v.size === currentSize }))
}

/** Shown when a size switch is refused because an applied bundle owns the line. */
export const SIZE_SWITCH_BUNDLE_MESSAGE = 'Lepas paket dulu, baru ganti ukuran.'

/** True when an applied bundle moved units of this product+size into a reward line.
 *  Removing such a line evicts the bundle and restores its units first, so a size
 *  switch would silently move fewer units than the sheet shows; the switch is refused. */
export function isLineInBundle(
  bundleFreed: Record<string, { productId: string; variantSize: string }[]>,
  productId: string,
  variantSize: string,
): boolean {
  return Object.values(bundleFreed).some((freed) =>
    freed.some((f) => f.productId === productId && f.variantSize === variantSize),
  )
}

export interface SizeSwitchPlan {
  productId: string
  fromSize: string
  toSize: string
  /** The add half, in the shape `addVariants` takes: the same quantity under the new size. */
  variantQtys: Record<string, number>
}

/** B1 size switch as the two reducer actions that already exist: CART_REMOVE_ITEM for the
 *  old size, then CART_ADD_ITEM for the new one (via `addVariants`, so the line takes the
 *  catalog price of the new size and merges into an existing line of that size). No new
 *  reducer action. Null when there is nothing valid to do: the current size, a size the
 *  product does not have, a reward line, or a line of another product. */
export function planSizeSwitch(line: CartItem, product: Product, toSize: string): SizeSwitchPlan | null {
  if (line.isReward || line.productId !== product.id) return null
  if (toSize === line.variantSize) return null
  if (!product.variants.some((v) => v.size === toSize)) return null
  return {
    productId: product.id,
    fromSize: line.variantSize,
    toSize,
    variantQtys: { [toSize]: line.quantity },
  }
}
