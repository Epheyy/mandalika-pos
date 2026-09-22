import { promotionHasKeyOverlap } from '@mandalika/types'
import type { components } from '@mandalika/api'
import type { CashierState } from './state/cashierReducer'
import type { AppliedPromoCode } from './promoValidate'
import type { BxgyRewardPick } from './BxgyRewardModal'
import { computeBundleFreed, shouldRemoveBundle, type BundleAssignment } from './bundle'
import { linkedPromoShape, bundleApplications, keyMatchesLine, bxgyRewardDue, bxgyRewardOptions, type BXGYRewardOption } from './pricing'
import { effectivePromotionSelection, isRedundantPromoCode } from './promotionSelection'
import { removePromotionEffect, evictAllForExclusive, reducePaidQty } from './promotionEffects'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']
export type PromotionOwner = { kind: 'direct'; promotion: Promotion } | { kind: 'code'; code: AppliedPromoCode }
export type FulfillmentChoice = { kind: 'bxgy'; picks: BxgyRewardPick[] } | { kind: 'bundle'; assignment: BundleAssignment }
export type FulfillmentPlan =
  | { kind: 'none' }
  | { kind: 'simple'; owner: PromotionOwner }
  | { kind: 'toggle'; promotion: Promotion }
  | { kind: 'bxgy-picker'; owner: PromotionOwner; promo: Promotion; options: BXGYRewardOption[]; due: number }
  | { kind: 'bundle-picker'; owner: PromotionOwner; promo: Promotion; cfg: NonNullable<Promotion['bundleConfig']>; cart: CartItem[] }
  | { kind: 'ready'; next: CashierState }

export function ownerMechanics(owner: PromotionOwner): Promotion | null {
  return owner.kind === 'direct' ? owner.promotion : owner.code.promotion ? linkedPromoShape(owner.code) : null
}

export function effectiveMechanics(state: CashierState): Promotion[] {
  const selected = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
  return [...selected.appliedPromotions, ...selected.appliedPromoCodes.filter(c => c.promotion).map(linkedPromoShape)]
}

// Preview preparation is pure: takeover and exclusive restoration only commit
// together with a confirmed physical effect. Cancelling a picker needs no undo.
function prepare(state: CashierState, owner: PromotionOwner, promo: Promotion): CashierState {
  let base = removePromotionEffect(state, promo.id)
  const incomingCombinable = owner.kind === 'direct' ? promo.combinable : owner.code.combinable
  if (!incomingCombinable || base.appliedPromotions.some(p => !p.combinable) || base.appliedPromoCodes.some(c => !c.combinable)) {
    base = { ...base, ...evictAllForExclusive(base), appliedPromotions: [], appliedPromoCodes: [] }
  }
  return base
}

export function promotionPreviewCart(state: CashierState, promotion: Promotion): CartItem[] {
  return prepare(state, { kind: 'direct', promotion }, promotion).cart
}

function install(base: CashierState, owner: PromotionOwner): CashierState {
  return {
    ...base,
    appliedPromotions: owner.kind === 'direct' ? [...base.appliedPromotions, owner.promotion] : base.appliedPromotions,
    appliedPromoCodes: owner.kind === 'code' ? [...base.appliedPromoCodes, owner.code] : base.appliedPromoCodes,
    promoCodeInput: owner.kind === 'code' ? '' : base.promoCodeInput,
    activeAdjustment: null,
  }
}

// The screen uses this for both paths and the reducer recomputes it against the
// current state at confirm time. A pending picker carries its original mechanics
// snapshot; it cannot install an owner or move goods merely by opening.
export function planPromotionFulfillment(
  state: CashierState, owner: PromotionOwner, products: Product[], choice?: FulfillmentChoice,
): FulfillmentPlan {
  if (owner.kind === 'code' && isRedundantPromoCode(state.appliedPromotions, state.appliedPromoCodes, owner.code)) return { kind: 'none' }
  const promo = ownerMechanics(owner)
  if (owner.kind === 'direct' && state.appliedPromotions.some(p => p.id === owner.promotion.id)) {
    // A late second picker confirmation is not a request to toggle the winner.
    return choice ? { kind: 'none' } : { kind: 'toggle', promotion: owner.promotion }
  }
  if (promo && promotionHasKeyOverlap(promo)) return { kind: 'none' }
  const separate = promo?.type === 'buy_x_get_y' && (promo.bxgyConfig?.getProductIds ?? []).length > 0
  if (!promo || (promo.type !== 'bundle' && !separate)) return { kind: 'simple', owner }
  const base = prepare(state, owner, promo), paid = base.cart.filter(c => !c.isReward)
  if (promo.type === 'bundle') {
    const cfg = promo.bundleConfig
    if (!cfg) return { kind: 'none' }
    const nApp = bundleApplications(cfg, paid)
    if (nApp < 1 || (choice && choice.kind !== 'bundle')) return { kind: 'none' }
    const slots = cfg.slots.map((slot, index) => ({ slot, index, need: nApp * slot.quantity,
      units: paid.filter(c => keyMatchesLine(slot.productKeys, c.productId, c.variantSize)).reduce((n, c) => n + c.quantity, 0) }))
    if (slots.some(s => s.units > s.need) && !choice) return { kind: 'bundle-picker', owner, promo, cfg, cart: base.cart }
    const assignment = choice?.kind === 'bundle' ? choice.assignment : undefined
    // A picker opened against an older cart may now have incomplete/invalid picks.
    for (const { slot, index, need, units } of slots) {
      const refs = assignment?.[index]
      if (!refs && units === need) continue
      if (!refs || refs.length !== need) return { kind: 'none' }
      const remaining = paid.filter(c => keyMatchesLine(slot.productKeys, c.productId, c.variantSize)).map(c => ({ ...c }))
      for (const ref of refs) {
        const match = remaining.find(c => c.productId === ref.productId && c.variantSize === ref.variantSize && c.quantity > 0)
        if (!match) return { kind: 'none' }
        match.quantity--
      }
    }
    const freed = computeBundleFreed(cfg, paid, assignment)
    if (!freed) return { kind: 'none' }
    // The existing allocator treats slots independently. An overlapping catalog
    // rule must never turn its overclaimed freed set into additional goods.
    // This contains impossible moves, without redesigning allocation/resources.
    const available = new Map(paid.map(c => [JSON.stringify([c.productId, c.variantSize]), c.quantity]))
    for (const f of freed) {
      const key = JSON.stringify([f.productId, f.variantSize]), left = (available.get(key) ?? 0) - f.quantity
      if (left < 0) return { kind: 'none' }
      available.set(key, left)
    }
    let cart = base.cart
    for (const f of freed) {
      cart = reducePaidQty(cart, f.productId, f.variantSize, f.quantity)
      cart = [...cart, { productId: f.productId, productName: f.productName, variantSize: f.variantSize,
        price: f.net, quantity: f.quantity, subtotal: Math.round(f.net * f.quantity), isReward: true, rewardPromotionId: promo.id }]
    }
    return { kind: 'ready', next: install({ ...base, cart, bundleFreed: { ...base.bundleFreed, [promo.id]: freed },
      bundleApplications: { ...base.bundleApplications, [promo.id]: nApp } }, owner) }
  }
  const due = bxgyRewardDue(promo.bxgyConfig, paid), options = bxgyRewardOptions(promo.bxgyConfig, products)
  if (due < 1 || options.length === 0 || (choice && choice.kind !== 'bxgy')) return { kind: 'none' }
  if (!choice && (options.length !== 1 || due !== 1)) return { kind: 'bxgy-picker', owner, promo, options, due }
  const picks = choice?.kind === 'bxgy' ? choice.picks : [options[0]]
  if (picks.length !== due) return { kind: 'none' }
  const rewards = new Map<string, CartItem>()
  for (const pick of picks) {
    const option = options.find(o => o.productId === pick.productId && o.variantSize === pick.variantSize)
    if (!option) return { kind: 'none' }
    const key = JSON.stringify([option.productId, option.variantSize])
    const prev = rewards.get(key), quantity = (prev?.quantity ?? 0) + 1
    rewards.set(key, { productId: option.productId, productName: option.productName, variantSize: option.variantSize,
      price: option.net, quantity, subtotal: option.net * quantity, isReward: true, rewardPromotionId: promo.id })
  }
  return { kind: 'ready', next: install({ ...base, cart: [...base.cart, ...rewards.values()] }, owner) }
}

// Used by the reactive screen path and immediately before checkout capture.
// Return whole owner IDs: removing only lines would leave a ghost linked code.
export function invalidPhysicalPromotionIds(state: CashierState): string[] {
  const invalid: string[] = [], paid = state.cart.filter(c => !c.isReward)
  for (const promo of effectiveMechanics(state)) {
    if (promotionHasKeyOverlap(promo)) { invalid.push(promo.id); continue }
    if (promo.type === 'bundle') {
      const freed = state.bundleFreed[promo.id], applied = state.bundleApplications[promo.id]
      const owned = [...paid, ...(freed ?? []).map(f => ({ productId: f.productId, productName: f.productName,
        variantSize: f.variantSize, price: f.fullPrice, quantity: f.quantity, subtotal: f.fullPrice * f.quantity }))]
      if (!promo.bundleConfig || !freed || applied == null || shouldRemoveBundle(promo.bundleConfig, owned, applied)) invalid.push(promo.id)
    } else if (promo.type === 'buy_x_get_y' && (promo.bxgyConfig?.getProductIds ?? []).length > 0) {
      const due = bxgyRewardDue(promo.bxgyConfig, paid)
      const units = state.cart.filter(c => c.isReward && c.rewardPromotionId === promo.id).reduce((n, c) => n + c.quantity, 0)
      if (due < 1 || units < 1 || units > due) invalid.push(promo.id)
    }
  }
  return invalid
}
