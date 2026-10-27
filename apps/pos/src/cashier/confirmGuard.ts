import type { components } from '@mandalika/api'
import { bxgyRewardDue, calcPromoDiscount } from './pricing'
import { effectivePromotionSelection } from './promotionSelection'
import { cashierReducer, type CashierAction, type CashierState } from './state/cashierReducer'
import { validateCode, validatePromo, violationMessage, type PromoEvalContext } from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

/** One discount that failed the confirm-time re-guard; everything else is kept. */
export type PromoDrop =
  | { kind: 'promotion'; id: string; name: string; reason: string; stripRewards: boolean }
  | { kind: 'code'; code: string; reason: string }

export interface ConfirmGuardInput {
  state: CashierState
  discountCodes: DiscountCode[]
  promotions: Promotion[]
  /** Validation context WITHOUT the subtotal; it is recomputed from the cart on each pass. */
  ctx: Omit<PromoEvalContext, 'subtotal'>
}

export interface ConfirmGuardResult {
  drops: PromoDrop[]
  /** Reducer actions that remove exactly the dropped items, in dispatch order. */
  actions: CashierAction[]
  /** Set when the surviving set still breaks the combinable rule (an invariant breach): clear all. */
  clearAll: boolean
  /** One toast line per dropped item. */
  messages: string[]
}

const cartSubtotal = (state: CashierState): number => state.cart.reduce((sum, item) => sum + item.subtotal, 0)

/** Single pass: every applied promotion / code that no longer validates against `state`. */
export function findInvalidPromos({ state, discountCodes, promotions, ctx }: ConfirmGuardInput): PromoDrop[] {
  const guardCtx: PromoEvalContext = { ...ctx, subtotal: cartSubtotal(state) }
  const { appliedPromotions, appliedPromoCodes } = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
  const drops: PromoDrop[] = []

  for (const p of appliedPromotions) {
    const violations = validatePromo(p, guardCtx)
    if (violations.length > 0) {
      drops.push({ kind: 'promotion', id: p.id, name: p.name, reason: violationMessage(violations[0]), stripRewards: false })
      continue
    }
    // buy_x_get_y has a cart precondition that gating cannot see. SEPARATE-SET earns a reward line
    // (calcPromoDiscount is always 0), so check bxgyRewardDue over PAID lines; SAME-SET discounts in place.
    if (p.type === 'buy_x_get_y') {
      const cfg = p.bxgyConfig
      const isSeparateSet = (cfg?.getProductIds ?? []).length > 0
      const unmet = isSeparateSet
        ? bxgyRewardDue(cfg, state.cart.filter((c) => !c.isReward)) < 1
        : calcPromoDiscount(p, state.cart, guardCtx.subtotal) <= 0
      if (unmet) {
        drops.push({ kind: 'promotion', id: p.id, name: p.name, reason: 'syarat beli belum terpenuhi', stripRewards: isSeparateSet })
      }
    }
  }

  // First occurrence wins, as the screen's .find() did.
  const activeCodeByName = new Map<string, DiscountCode>()
  for (const d of discountCodes) {
    const key = d.code.toUpperCase()
    if (d.isActive && !activeCodeByName.has(key)) activeCodeByName.set(key, d)
  }
  const activePromoById = new Map<string, Promotion>()
  for (const p of promotions) if (p.isActive && !activePromoById.has(p.id)) activePromoById.set(p.id, p)

  for (const c of appliedPromoCodes) {
    const dc = activeCodeByName.get(c.code.toUpperCase())
    if (!dc) {
      drops.push({ kind: 'code', code: c.code, reason: 'kode tidak ditemukan' })
      continue
    }
    const violations = validateCode(dc, guardCtx)
    if (violations.length > 0) {
      drops.push({ kind: 'code', code: c.code, reason: violationMessage(violations[0]) })
      continue
    }
    // SP-Promo-3c: a linked code must also pass its linked promotion (decideApplyCode's intersection rule).
    if (c.promotion) {
      const linked = activePromoById.get(c.promotion.id)
      if (!linked) {
        drops.push({ kind: 'code', code: c.code, reason: 'promo tertaut tidak tersedia' })
        continue
      }
      const linkedViolations = validatePromo(linked, guardCtx)
      if (linkedViolations.length > 0) {
        drops.push({ kind: 'code', code: c.code, reason: violationMessage(linkedViolations[0]) })
      }
    }
  }
  return drops
}

const dropKey = (d: PromoDrop): string => (d.kind === 'promotion' ? `p:${d.id}` : `c:${d.code}`)

function actionsFor(drops: PromoDrop[]): CashierAction[] {
  return drops.flatMap((d): CashierAction[] =>
    d.kind === 'promotion'
      ? [
          ...(d.stripRewards ? [{ type: 'CART_REMOVE_PROMO_REWARDS', rewardPromotionId: d.id } as const] : []),
          { type: 'REMOVE_PROMOTION', id: d.id },
        ]
      : [{ type: 'REMOVE_PROMO_CODE', code: d.code }],
  )
}

function messageFor(d: PromoDrop): string {
  return d.kind === 'promotion'
    ? `Promo ${d.name} tidak berlaku lagi (${d.reason}). Dihapus dari keranjang; promo lain tetap.`
    : `Kode Promo ${d.code} tidak berlaku lagi (${d.reason}). Dihapus dari keranjang; promo lain tetap.`
}

function breaksCombinableRule(state: CashierState): boolean {
  const { appliedPromotions, appliedPromoCodes } = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
  return (
    appliedPromotions.length + appliedPromoCodes.length > 1 &&
    (appliedPromotions.some((p) => !p.combinable) || appliedPromoCodes.some((c) => !c.combinable))
  )
}

/**
 * Confirm-time re-guard, per item: drop only what failed and keep the rest. Removing a bundle or a
 * reward giveaway moves goods back to paid lines, which can change the subtotal, so the survivors
 * are validated ONCE more against the post-removal state (no loop: whatever that second pass drops
 * is final). The cashier re-confirms a clean total afterwards, as before.
 */
export function resolveConfirmGuard(input: ConfirmGuardInput): ConfirmGuardResult {
  const first = findInvalidPromos(input)
  const afterFirst = actionsFor(first).reduce(cashierReducer, input.state)
  const known = new Set(first.map(dropKey))
  const second = first.length > 0 ? findInvalidPromos({ ...input, state: afterFirst }).filter((d) => !known.has(dropKey(d))) : []
  const drops = [...first, ...second]
  const actions = actionsFor(drops)
  const final = actions.reduce(cashierReducer, input.state)
  return { drops, actions, clearAll: breaksCombinableRule(final), messages: drops.map(messageFor) }
}
