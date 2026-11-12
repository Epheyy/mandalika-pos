import type { components } from '@mandalika/api'
import type { CashierState } from './state/cashierReducer'
import type { BundleFreedUnit } from './bundle'
import { repriceBundles } from './setBundles'
type CartItem = components['schemas']['CartItem']

// Physical ownership is promotion-ID based, independent of direct/code selection.
// Only retained bundle bookkeeping can restore paid units, making repeat removal
// harmless. A stale caller's freed-set argument must not restore a second time.
export function removePromotionEffect(state: CashierState, id: string): CashierState {
  const freed = state.bundleFreed[id]
  // Ends with repriceBundles: removing a Diskon Bundle hands its bundles back their full price.
  return repriceBundles({
    ...state,
    cart: freed ? restoreBundle(state.cart, id, freed) : state.cart.filter(c => !(c.isReward && c.rewardPromotionId === id)),
    ...clearBundleEntry(state, id),
    appliedPromotions: state.appliedPromotions.filter(p => p.id !== id),
    appliedPromoCodes: state.appliedPromoCodes.filter(c => c.promotion?.id !== id),
  })
}

export function upsertCartItem(cart: CartItem[], item: CartItem): CartItem[] {
  const idx = cart.findIndex(
    (c) =>
      c.productId === item.productId &&
      c.variantSize === item.variantSize &&
      !c.isReward &&
      c.bundleGroup == null,
  )
  if (idx >= 0) {
    const existing = cart[idx]
    const newQty = existing.quantity + item.quantity
    const updated: CartItem = {
      ...existing,
      quantity: newQty,
      price: item.price,
      subtotal: Math.round(newQty * item.price),
    }
    return [...cart.slice(0, idx), updated, ...cart.slice(idx + 1)]
  }
  return [...cart, item]
}

// reducePaidQty: decrement a PAID (non-reward) line's quantity by `dec`, removing
// the line when it reaches 0. Reward lines of the same product are untouched.
// Used by APPLY_BUNDLE to move freed units off their paid line.
export function reducePaidQty(
  cart: CartItem[],
  productId: string,
  variantSize: string,
  dec: number,
): CartItem[] {
  return cart.flatMap((c) => {
    if (c.isReward || c.bundleGroup != null || c.productId !== productId || c.variantSize !== variantSize) return [c]
    const newQty = c.quantity - dec
    if (newQty <= 0) return []
    return [{ ...c, quantity: newQty, subtotal: Math.round(newQty * c.price) }]
  })
}

// restoreBundle: inverse of a bundle application. Strip this bundle's reward
// lines and add the freed units back onto their paid lines at full price
// (merging into an existing paid line, recreating it when it was fully consumed).
// Pure and catalog-free — fullPrice comes from the retained freed set. Used by
// REMOVE_BUNDLE and by every generic reward-strip path so a freed physical unit
// is never dropped without its paid quantity being restored.
export function restoreBundle(
  cart: CartItem[],
  promotionId: string,
  freed: BundleFreedUnit[],
): CartItem[] {
  let next = cart.filter((c) => !(c.isReward && c.rewardPromotionId === promotionId))
  for (const f of freed) {
    next = upsertCartItem(next, {
      productId: f.productId,
      productName: f.productName,
      variantSize: f.variantSize,
      price: f.fullPrice,
      quantity: f.quantity,
      subtotal: Math.round(f.fullPrice * f.quantity),
    })
  }
  return next
}

// restoreAllBundles: restore every applied bundle's paid quantity (stripping its
// reward lines), returning the rebuilt cart. Callers then strip any remaining
// (non-bundle) reward lines and reset bundleFreed to {}.
export function restoreAllBundles(
  cart: CartItem[],
  bundleFreed: Record<string, BundleFreedUnit[]>,
): CartItem[] {
  let next = cart
  for (const [promotionId, freed] of Object.entries(bundleFreed)) {
    next = restoreBundle(next, promotionId, freed)
  }
  return next
}

// evictAllForExclusive: an incoming exclusive (non-combinable) promo/code
// replaces the whole applied set. Any applied bundle MOVED units off their paid
// line, so restore them first (else ghost Rp0 reward lines + a stale freed entry
// linger), then strip every remaining promo reward line (bxgy extras). Loyalty
// rewards (rewardConditionId, no rewardPromotionId) survive — they're
// customer-based, not promo-based. Mirrors CLEAR_PROMOTIONS' cart handling.
export function evictAllForExclusive(
  state: CashierState,
): Pick<CashierState, 'cart' | 'bundleFreed' | 'bundleApplications'> {
  const restored = restoreAllBundles(state.cart, state.bundleFreed)
  return {
    cart: restored.filter((c) => !(c.isReward && c.rewardPromotionId)),
    bundleFreed: {},
    bundleApplications: {},
  }
}

// omitKey: return a shallow copy of the map without `key` (immutable delete).
export function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const { [key]: _removed, ...rest } = map
  return rest
}

// clearBundleEntry: drop a single bundle id from BOTH bookkeeping maps together,
// so a freed set can never outlive its applied-nApp count (or vice versa). Every
// path that clears one entry MUST go through here to keep the two maps in
// lock-step. Returns the slice of state to spread into the result.
export function clearBundleEntry(
  state: CashierState,
  id: string,
): Pick<CashierState, 'bundleFreed' | 'bundleApplications'> {
  return {
    bundleFreed: omitKey(state.bundleFreed, id),
    bundleApplications: omitKey(state.bundleApplications, id),
  }
}
