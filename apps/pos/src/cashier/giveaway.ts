import type { components } from '@mandalika/api'
import type { QuoteLineInput } from './receiptQuote'
import { stockFor } from './stock'

type Bundle = components['schemas']['SyncPullBundle']
type Product = components['schemas']['Product']

/** The outlet's per-sale giveaway as the pull bundle carries it (absent = none). */
export type GiveawayConfig = NonNullable<Bundle['outletGiveaway']>

/**
 * C3: the free item the server adds to every completed sale of this outlet (one unit, appended to the
 * ledger document in the ledger hook), shown as a Rp0 line. It is DERIVED display state: it never enters
 * the cart reducer, so it can never reach the order payload, the promo validator or the loyalty
 * evaluation. The server decides what is really taken; this only shows it.
 */
export interface GiveawayLine extends QuoteLineInput {
  quantity: 1
  price: 0
  subtotal: 0
  isReward: true
  /** The displayed stock of the item is at or below zero: the line warns, the sale proceeds. */
  outOfStock: boolean
}

interface CartLineLike {
  isReward?: boolean
  quantity: number
}

/** Shown on the line while the item is out of stock; the sale is never blocked by it. */
export const GIVEAWAY_OUT_OF_STOCK = 'Stok hadiah habis'
export const GIVEAWAY_CAPTION = 'Hadiah pembelian'

/** Displayed stock of the giveaway item: the pending-adjusted catalog when it lists the item, else the
 *  pull's stock minus this tablet's unsynced sales (the item need not be sellable, so may be missing from the catalog). */
export function giveawayStock(
  config: GiveawayConfig,
  displayProducts: Product[],
  pendingDeltas: Record<string, number>,
): number {
  const listed = stockFor(displayProducts, config.productId, config.variantSize)
  if (listed !== null) return listed
  return (config.stock ?? 0) - (pendingDeltas[`${config.productId}|${config.variantSize}`] ?? 0)
}

/** The giveaway line for this cart, or null: no giveaway configured, or nothing in the cart. The server gives one
 *  per completed order whatever the cart holds (a reward-only order included), so any line counts. */
export function giveawayLine(
  cart: readonly CartLineLike[],
  config: GiveawayConfig | null | undefined,
  stock: number,
): GiveawayLine | null {
  if (!config) return null
  if (!cart.some((c) => c.quantity > 0)) return null
  return {
    productId: config.productId,
    productName: config.productName,
    variantSize: config.variantSize,
    quantity: 1,
    price: 0,
    subtotal: 0,
    isReward: true,
    outOfStock: stock <= 0,
  }
}
