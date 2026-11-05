/**
 * Promo auto-apply reconcile (plan docs/plans/2026-11-05-promo-auto-apply.md §2).
 *
 * PURE: no reducer, effect, UI or storage. Given the current cashier state and
 * which applied promotions the reconcile installed earlier, it returns the state
 * with the TARGET auto set installed, the new auto id list, and any "Pilih
 * hadiah" prompts. S4 wires it into the reducer / screen.
 *
 * Determinism: the target is always computed from a BASE (current state with
 * every auto entry's effect removed), so it depends only on what the cashier
 * rang and chose, never on the order earlier installs happened in. Same inputs
 * give the same target, hence idempotence (`changed === false` on a re-run).
 *
 * The server never picks promos; it only validates what the POS submits. The
 * output must therefore satisfy `validatePromo` and the combinability rule.
 */

import type { components } from '@mandalika/api'
import { promotionHasKeyOverlap } from '@mandalika/types'
import type { CashierState } from './state/cashierReducer'
import { calcPromoDiscount, computePricing, type PricingInput } from './pricing'
import { validatePromo } from './promoValidate'
import { isSeparateSetBxgy, unmetCartPrecondition } from './promoEligibility'
import { effectiveMechanics, invalidPhysicalPromotionIds, planPromotionFulfillment } from './promotionFulfillment'
import { removePromotionEffect } from './promotionEffects'
import { stockFor } from './stock'

type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

export interface AutoPromoContext {
  now: Date
  outletId: string
  /** Outlet timezone (A28): promo hours/dates are evaluated on this clock. */
  timezone?: string | null
}

export interface AutoPromoInput {
  state: CashierState
  /** Applied promotion ids the reconcile installed earlier (S4 keeps this in state). */
  autoPromotionIds: readonly string[]
  /** Auto promos the cashier removed for this sale. */
  dismissedPromotionIds: readonly string[]
  promotions: readonly Promotion[]
  /** Stock-adjusted catalogue (pending sales already subtracted). */
  products: readonly Product[]
  ctx: AutoPromoContext
}

export type AutoPromptReason = 'pick-gift' | 'out-of-stock'

/** A qualifying auto promo the reconcile did NOT install; the cart shows "Pilih hadiah". */
export interface AutoPrompt {
  promotionId: string
  promotionName: string
  reason: AutoPromptReason
}

export interface AutoReconcileResult {
  next: CashierState
  autoPromotionIds: string[]
  changed: boolean
  prompts: AutoPrompt[]
}

type Step =
  | { kind: 'installed'; state: CashierState }
  | { kind: 'prompt'; reason: AutoPromptReason }
  | { kind: 'skip' }

interface Option {
  state: CashierState
  installed: Promotion[]
  prompts: AutoPrompt[]
  saving: number
}

const cartSubtotal = (cart: CartItem[]): number => cart.reduce((s, c) => s + c.subtotal, 0)

const byAge = (a: Promotion, b: Promotion): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

const isPhysical = (p: Promotion): boolean => p.type === 'bundle' || isSeparateSetBxgy(p)

// Neutral settings: only the promo discount is read, tax/rounding/loyalty are off.
const NEUTRAL_SETTINGS = { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as unknown as PricingInput['settings']
const NEUTRAL_LOYALTY = { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as unknown as PricingInput['loyalty']

function evalCtx(state: CashierState, ctx: AutoPromoContext) {
  return {
    now: ctx.now,
    outletId: ctx.outletId,
    timezone: ctx.timezone,
    subtotal: cartSubtotal(state.cart),
    hasCustomer: state.selectedCustomer != null,
    customerId: state.selectedCustomer?.id,
  }
}

// Stable identity of the parts of a state the reconcile can change. Order-insensitive
// (removing and re-installing a bundle may reorder cart lines).
function signature(state: CashierState, autoIds: readonly string[]): string {
  const lines = state.cart
    .map((c) => [c.productId, c.variantSize, c.quantity, c.price, c.isReward ? 1 : 0, c.rewardPromotionId ?? '', c.rewardConditionId ?? ''].join('|'))
    .sort()
  return JSON.stringify([
    [...autoIds].sort(),
    state.appliedPromotions.map((p) => JSON.stringify(p)).sort(),
    state.appliedPromoCodes.map((c) => c.code).sort(),
    lines,
    Object.entries(state.bundleApplications).sort(),
  ])
}

// Manual promos that no longer qualify on `state`. An auto install must never
// make a cashier-chosen promo invalid (plan §2.4): it is compared with the same
// check on the base, so a manual promo that was already invalid is not blamed.
function manualFaults(state: CashierState, manual: Promotion[], ctx: AutoPromoContext): Set<string> {
  const ec = evalCtx(state, ctx)
  const physicalBad = new Set(invalidPhysicalPromotionIds(state))
  const faults = new Set<string>()
  for (const p of manual) {
    if (
      validatePromo(p, ec).length > 0 ||
      physicalBad.has(p.id) ||
      (!isPhysical(p) && p.type === 'buy_x_get_y' &&
        unmetCartPrecondition(p, state.cart, calcPromoDiscount(p, state.cart, ec.subtotal)) !== null)
    ) faults.add(p.id)
  }
  return faults
}

interface Manual { promos: Promotion[]; baseFaults: Set<string> }

const breaksManual = (next: CashierState, manual: Manual, ctx: AutoPromoContext): boolean =>
  [...manualFaults(next, manual.promos, ctx)].some((id) => !manual.baseFaults.has(id))

// One candidate against the working state: gate, cart precondition, plan, stock,
// and it must leave every manual promo valid.
function tryInstall(
  cur: CashierState, promo: Promotion, products: Product[], ctx: AutoPromoContext, manual: Manual,
): Step {
  const step = planInstall(cur, promo, products, ctx)
  return step.kind === 'installed' && breaksManual(step.state, manual, ctx) ? { kind: 'skip' } : step
}

function planInstall(
  cur: CashierState, promo: Promotion, products: Product[], ctx: AutoPromoContext,
): Step {
  const ec = evalCtx(cur, ctx)
  if (promotionHasKeyOverlap(promo) || validatePromo(promo, ec).length > 0) return { kind: 'skip' }
  const savings = calcPromoDiscount(promo, cur.cart, ec.subtotal)
  if (unmetCartPrecondition(promo, cur.cart, savings) !== null) return { kind: 'skip' }
  const plan = planPromotionFulfillment(cur, { kind: 'direct', promotion: promo }, products)
  switch (plan.kind) {
    case 'simple':
      // A promo that saves nothing right now (e.g. tiered below its first tier)
      // is not worth an "Otomatis" row.
      return savings > 0
        ? { kind: 'installed', state: { ...cur, appliedPromotions: [...cur.appliedPromotions, promo], activeAdjustment: null } }
        : { kind: 'skip' }
    case 'ready': {
      // The picker caps a free gift at stock whatever allowNegativeStock says; auto does the same.
      // Gifts already in the cart (other promos, loyalty rewards) share the same stock.
      if (promo.type === 'buy_x_get_y') {
        const given = (pid: string, size: string) => plan.next.cart
          .filter((c) => c.isReward && c.productId === pid && c.variantSize === size &&
            !(c.rewardPromotionId && plan.next.bundleFreed[c.rewardPromotionId]))
          .reduce((n, c) => n + c.quantity, 0)
        for (const line of plan.next.cart) {
          if (!line.isReward || line.rewardPromotionId !== promo.id) continue
          const stock = stockFor(products, line.productId, line.variantSize)
          if (stock !== null && given(line.productId, line.variantSize) > Math.max(0, stock)) {
            return { kind: 'prompt', reason: 'out-of-stock' }
          }
        }
      }
      return { kind: 'installed', state: plan.next }
    }
    case 'bxgy-picker':
    case 'bundle-picker':
      return { kind: 'prompt', reason: 'pick-gift' }
    default:
      return { kind: 'skip' }
  }
}

// Remove-only settling: re-gate every installed promo against the FINAL cart (a
// bundle can lower the subtotal under another promo's minPurchase) and drop any
// that no longer qualify. Removal only restores full prices, so it terminates
// and never introduces a new violation; chains settle in 2 passes (tested).
function settle(
  state: CashierState, installed: Promotion[], ctx: AutoPromoContext,
): { state: CashierState; installed: Promotion[] } {
  let cur = state
  let kept = installed
  for (;;) {
    const ec = evalCtx(cur, ctx)
    const physicalBad = new Set(invalidPhysicalPromotionIds(cur))
    const bad = kept.filter((p) => validatePromo(p, ec).length > 0 || physicalBad.has(p.id))
    if (bad.length === 0) return { state: cur, installed: kept }
    const badIds = new Set(bad.map((p) => p.id))
    for (const p of bad) cur = removePromotionEffect(cur, p.id)
    kept = kept.filter((p) => !badIds.has(p.id))
  }
}

// Money the customer saves with an option: the promo discount plus the value of
// reward lines / freed bundle units (calcPromoDiscount is 0 for those).
function autoSaving(state: CashierState, installed: Promotion[], products: Product[]): number {
  const money = computePricing({
    cart: state.cart,
    discountType: state.appliedDiscountType,
    surchargeType: state.appliedSurchargeType,
    discountRunning: state.discountRunning,
    surchargeRunning: state.surchargeRunning,
    appliedPromotions: state.appliedPromotions,
    appliedPromoCodes: state.appliedPromoCodes,
    settings: NEUTRAL_SETTINGS,
    loyalty: NEUTRAL_LOYALTY,
    hasCustomer: false,
    pointsRedeemed: 0,
    customerPoints: 0,
  }).appliedPromoDiscountAmount
  let value = 0
  for (const p of installed) {
    if (p.type === 'bundle') {
      for (const f of state.bundleFreed[p.id] ?? []) value += (f.fullPrice - f.net) * f.quantity
    } else if (isSeparateSetBxgy(p)) {
      for (const line of state.cart) {
        if (!line.isReward || line.rewardPromotionId !== p.id) continue
        const variant = products.find((x) => x.id === line.productId)?.variants.find((v) => v.size === line.variantSize)
        if (variant) value += (variant.price - line.price) * line.quantity
      }
    }
  }
  return money + value
}

// Install one option's candidates in a stable order: physical first, then simple.
function evaluateOption(
  base: CashierState, candidates: Promotion[], products: Product[], ctx: AutoPromoContext, manual: Manual,
): Option {
  const ordered = [...candidates.filter(isPhysical).sort(byAge), ...candidates.filter((p) => !isPhysical(p)).sort(byAge)]
  let cur = base
  let installed: Promotion[] = []
  const prompts: AutoPrompt[] = []
  for (const promo of ordered) {
    const step = tryInstall(cur, promo, products, ctx, manual)
    if (step.kind === 'installed') {
      cur = step.state
      installed = [...installed, promo]
    } else if (step.kind === 'prompt') {
      prompts.push({ promotionId: promo.id, promotionName: promo.name, reason: step.reason })
    }
  }
  const settled = settle(cur, installed, ctx)
  return { state: settled.state, installed: settled.installed, prompts, saving: autoSaving(settled.state, settled.installed, products) }
}

// Larger saving wins; a tie goes to the option whose oldest promo is older, then lowest id.
function betterOption(a: Option, b: Option): Option {
  if (a.saving !== b.saving) return a.saving > b.saving ? a : b
  const oldest = (o: Option) => [...o.installed].sort(byAge)[0]
  return byAge(oldest(a), oldest(b)) <= 0 ? a : b
}

export function reconcileAutoPromos(input: AutoPromoInput): AutoReconcileResult {
  const { state, autoPromotionIds, dismissedPromotionIds, ctx } = input
  const products = [...input.products]
  const before = signature(state, autoPromotionIds)

  let base = state
  for (const id of autoPromotionIds) base = removePromotionEffect(base, id)

  const manualPromos = effectiveMechanics(base)
  const manual: Manual = { promos: manualPromos, baseFaults: manualFaults(base, manualPromos, ctx) }
  const manualCodes = base.appliedPromoCodes
  const manualPresent = base.appliedPromotions.length > 0 || manualCodes.length > 0
  const manualExclusive = base.appliedPromotions.some((p) => !p.combinable) || manualCodes.some((c) => !c.combinable)

  const finish = (winner: Option | null, prompts: AutoPrompt[]): AutoReconcileResult => {
    const target = winner ? winner.state : base
    const ids = winner ? winner.installed.map((p) => p.id) : []
    const kept = new Set(ids)
    const changed = signature(target, ids) !== before
    return {
      // Unchanged: hand back the caller's own state (no reordered lines, no cleared adjustment panel).
      next: changed ? target : state,
      autoPromotionIds: ids,
      changed,
      prompts: prompts.filter((p) => !kept.has(p.promotionId)),
    }
  }

  // Manual always wins: an exclusive manual discount holds every auto promo back.
  if (manualExclusive) return finish(null, [])

  const taken = new Set(manualPromos.map((p) => p.id))
  const dismissed = new Set(dismissedPromotionIds)
  const candidates = input.promotions.filter(
    (p) => p.isActive && p.autoApply === true && !p.codeOnly && !dismissed.has(p.id) && !taken.has(p.id),
  )
  // With a combinable manual discount only combinable auto promos may join.
  const combinable = candidates.filter((p) => p.combinable === true)
  const exclusive = manualPresent ? [] : candidates.filter((p) => p.combinable !== true)

  const options: Option[] = []
  if (combinable.length > 0) options.push(evaluateOption(base, combinable, products, ctx, manual))
  for (const promo of exclusive) options.push(evaluateOption(base, [promo], products, ctx, manual))

  const viable = options.filter((o) => o.installed.length > 0 && o.saving > 0)
  const winner = viable.length > 0 ? viable.reduce(betterOption) : null

  const seen = new Set<string>()
  const prompts = options.flatMap((o) => o.prompts).filter((p) => !seen.has(p.promotionId) && seen.add(p.promotionId))
  return finish(winner, prompts)
}
