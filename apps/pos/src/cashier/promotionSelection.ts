import type { components } from '@mandalika/api'
import type { AppliedPromoCode } from './promoValidate'

type Promotion = components['schemas']['Promotion']

export function isRedundantPromoCode(
  promotions: Promotion[], codes: AppliedPromoCode[], incoming: AppliedPromoCode,
): boolean {
  return codes.some(c => c.code === incoming.code) || !!(incoming.promotion && (
    promotions.some(p => p.id === incoming.promotion!.id) ||
    codes.some(c => c.promotion?.id === incoming.promotion!.id)
  ))
}

// Mirrors resolvePromos: direct IDs first, then the first linked code per ID.
// This is a projection of the current draft, never a migration of queued sales.
// Keep winning objects/raw code identities unchanged and retain stable references
// when the input already satisfies the invariant.
export function effectivePromotionSelection(promotions: Promotion[], codes: AppliedPromoCode[]) {
  const seen = new Set<string>()
  const direct = promotions.filter(p => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })
  const rawCodes = new Set<string>()
  const effectiveCodes = codes.filter(c => {
    if (rawCodes.has(c.code) || (c.promotion && seen.has(c.promotion.id))) return false
    rawCodes.add(c.code)
    if (c.promotion) seen.add(c.promotion.id)
    return true
  })
  return {
    appliedPromotions: direct.length === promotions.length ? promotions : direct,
    appliedPromoCodes: effectiveCodes.length === codes.length ? codes : effectiveCodes,
  }
}
