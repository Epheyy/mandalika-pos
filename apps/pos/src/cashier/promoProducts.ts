/**
 * Products the catalogue "Promo" tab lists (F7 / W1-09). PURE, read-only, built from the promotions already on the
 * tablet. A product is listed when an active promotion explicitly targets it:
 *   - percentage / fixed / bogo: its `applicableProductIds` (empty = storewide, so it marks nothing);
 *   - buy_x_get_y: its buy and get keys (empty both sides = storewide);
 *   - bundle: every slot's product keys.
 * Tiered promotions are storewide spend thresholds and mark nothing. Keys are `pid` or `pid|size`; the product id is
 * the part before `|` (same contract as promotionKeysOverlap).
 *
 * Gating mirrors the engine's own date / weekday / hours / outlet check (`validatePromo`), minus the minimum
 * purchase: that depends on the cart, and the tab only answers "is this item in a live promotion". Code-only
 * promotions are skipped (the cashier cannot reach them from the panel).
 */

import type { components } from '@mandalika/api'
import { promotionHasKeyOverlap } from '@mandalika/types'
import { validatePromo, type PromoEvalContext } from './promoValidate'

type Promotion = components['schemas']['Promotion']

const productOf = (key: string): string => {
  const i = key.indexOf('|')
  return i < 0 ? key : key.slice(0, i)
}

function targetedProductIds(p: Promotion): string[] {
  switch (p.type) {
    case 'bundle':
      return (p.bundleConfig?.slots ?? []).flatMap((s) => s.productKeys.map(productOf))
    case 'buy_x_get_y':
      return [...(p.bxgyConfig?.buyProductIds ?? []), ...(p.bxgyConfig?.getProductIds ?? [])].map(productOf)
    case 'tiered':
      return []
    default:
      return p.applicableProductIds ?? []
  }
}

export function promoProductIds(
  promotions: readonly Promotion[],
  ctx: Pick<PromoEvalContext, 'now' | 'outletId' | 'timezone'>,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const p of promotions) {
    // Overlapping keys make the engine ignore the promo (pricing returns 0), so it is not a live promotion.
    if (!p.isActive || p.codeOnly || promotionHasKeyOverlap(p)) continue
    const open = validatePromo(p, { ...ctx, subtotal: Number.MAX_SAFE_INTEGER, hasCustomer: true }).length === 0
    if (!open) continue
    for (const id of targetedProductIds(p)) out.add(id)
  }
  return out
}

/** Sentinel category id for the virtual "Promo" tab (never a real category uuid). */
export const PROMO_TAB_ID = '__promo__'
