import type { components } from '@mandalika/api'
import { resolveConfirmGuard } from './confirmGuard'
import { heldCustomerRecord, type HeldAdjustment, type HeldOrder } from './heldOrders'
import { invalidPhysicalPromotionIds, ownerMechanics, planPromotionFulfillment, type FulfillmentChoice, type PromotionOwner } from './promotionFulfillment'
import { decideApplyCode, type PromoEvalContext } from './promoValidate'
import { isRedundantPromoCode } from './promotionSelection'
import { CASHIER_INITIAL_STATE, cashierReducer, type CashierAction, type CashierState } from './state/cashierReducer'

type Product = components['schemas']['Product']
type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

export interface HeldRestoreEnv {
  /** The current (stock-adjusted) catalog: lines are re-priced from it, a retired size is named and left out. */
  products: Product[]
  promotions: Promotion[]
  discountCodes: DiscountCode[]
  /** Promo clock and outlet; the subtotal and customer fields are filled in here. */
  ctx: Pick<PromoEvalContext, 'now' | 'outletId' | 'timezone'>
}

export interface HeldRestorePlan {
  /** Reducer actions in dispatch order. The first is CART_CLEAR: restoring REPLACES the current cart. */
  actions: CashierAction[]
  /** False when a line could not come back: the held order should then be kept. */
  lossless: boolean
  /** One line per thing that could not come back (retired size, lapsed promo, loyalty to re-pick). */
  notes: string[]
  /** The state the actions produce from a clean sale, for tests and previews. */
  result: CashierState
}

const subtotal = (s: CashierState): number => s.cart.reduce((sum, i) => sum + i.subtotal, 0)
const isSeparateSetBxgy = (p: Pick<Promotion, 'type' | 'bxgyConfig'>): boolean =>
  p.type === 'buy_x_get_y' && (p.bxgyConfig?.getProductIds ?? []).length > 0

/**
 * Plan how a held order comes back, by composing EXISTING reducer actions only (no new action type):
 * clear, customer, salesman, re-priced lines, notes, manual adjustments, then each promotion and code through
 * the same fulfillment planner the Promo & Diskon sheet uses, then the confirm-time guard (B2) so anything that
 * no longer validates is dropped with its per-item message. Pure: it folds the actions through the reducer to plan
 * against the state they build, and never touches storage or the catalog.
 */
export function planHeldRestore(held: HeldOrder, env: HeldRestoreEnv): HeldRestorePlan {
  let state = CASHIER_INITIAL_STATE
  const actions: CashierAction[] = []
  const notes: string[] = []
  const push = (a: CashierAction): void => {
    actions.push(a)
    state = cashierReducer(state, a)
  }
  const evalCtx = (): PromoEvalContext => ({
    ...env.ctx,
    subtotal: subtotal(state),
    hasCustomer: held.customer !== null,
    customerId: held.customer?.id,
  })

  push({ type: 'CART_CLEAR' })
  // CART_CLEAR resets the dismissed set, so it is restored AFTER the clear (or a removed auto promo would come back).
  // Auto promos themselves are not stored: the screen's reconcile re-installs them once this restore commits.
  const dismissedAuto = Array.isArray(held.dismissedAutoPromotionIds) ? held.dismissedAutoPromotionIds.filter((id) => typeof id === 'string') : []
  if (dismissedAuto.length > 0) push({ type: 'SET_DISMISSED_AUTO_PROMOS', ids: dismissedAuto })
  if (held.customer) push({ type: 'SET_CUSTOMER', customer: heldCustomerRecord(held.customer, held.heldAt) })
  if (held.salesman) push({ type: 'SET_SALESMAN', salesman: held.salesman })

  const retired: string[] = []
  for (const line of held.lines) {
    const variant = env.products.find((p) => p.id === line.productId)?.variants.find((v) => v.size === line.variantSize)
    if (!variant) {
      if (!retired.includes(line.productName)) retired.push(line.productName)
      continue
    }
    push({ type: 'CART_ADD_ITEM', item: { ...line, price: variant.price, subtotal: Math.round(variant.price * line.quantity) } })
  }
  if (retired.length > 0) notes.push(`Tidak bisa dipulihkan: ${retired.join(', ')} (sudah tidak dijual)`)

  if (held.notes) push({ type: 'SET_ORDER_NOTES', notes: held.notes })
  // APPLY_SURCHARGE and APPLY_DISCOUNT both snapshot the STAGED type, so stage each kind before applying it.
  const applyAdjustment = (adj: HeldAdjustment, kind: 'APPLY_DISCOUNT' | 'APPLY_SURCHARGE'): void => {
    if (adj.value <= 0) return
    push({ type: 'SET_DISCOUNT_TYPE', discountType: adj.type })
    push({ type: kind, value: adj.value })
  }
  applyAdjustment(held.discount, 'APPLY_DISCOUNT')
  applyAdjustment(held.surcharge, 'APPLY_SURCHARGE')
  push({ type: 'SET_DISCOUNT_TYPE', discountType: held.stagedDiscountType })

  const install = (owner: PromotionOwner, name: string, promoId: string | null): void => {
    const mech = ownerMechanics(owner)
    const picks = promoId ? held.rewardPicks[promoId] : undefined
    const separate = !!mech && isSeparateSetBxgy(mech)
    const choice: FulfillmentChoice | undefined = separate && picks && picks.length > 0 ? { kind: 'bxgy', picks } : undefined
    const plan = planPromotionFulfillment(state, owner, env.products, choice)
    if (plan.kind === 'simple') {
      push(owner.kind === 'direct'
        ? { type: 'APPLY_PROMOTION', promotion: owner.promotion }
        : { type: 'APPLY_PROMO_CODE', code: owner.code, combinable: !!owner.code.combinable })
    } else if (plan.kind === 'ready') {
      push({ type: 'APPLY_FULFILLMENT', owner, products: env.products, choice })
    } else {
      notes.push(`${name}: pilih ulang di Promo & Diskon`)
    }
  }

  for (const saved of held.promotions) {
    const promo = env.promotions.find((p) => p.id === saved.id && p.isActive)
    if (!promo) { notes.push(`Promo ${saved.name} tidak tersedia lagi`); continue }
    install({ kind: 'direct', promotion: promo }, `Promo ${promo.name}`, promo.id)
  }
  for (const typed of held.codes) {
    const decision = decideApplyCode(typed, env.discountCodes, evalCtx(), env.promotions)
    if (!decision.ok) { notes.push(`Kode Promo ${typed} tidak berlaku lagi (${decision.reason.toLowerCase()})`); continue }
    if (isRedundantPromoCode(state.appliedPromotions, state.appliedPromoCodes, decision.code)) continue
    install({ kind: 'code', code: decision.code }, `Kode Promo ${typed}`, decision.code.promotion?.id ?? null)
  }

  // Everything installed is checked once more against the live clock and the rebuilt cart (B2 re-guard).
  const guard = resolveConfirmGuard({ state, discountCodes: env.discountCodes, promotions: env.promotions, ctx: { ...env.ctx, hasCustomer: held.customer !== null, customerId: held.customer?.id } })
  for (const a of guard.actions) push(a)
  notes.push(...guard.messages)
  if (guard.clearAll) {
    push({ type: 'CLEAR_PROMOTIONS' })
    notes.push('Promo/Kode Promo tidak bisa digabung lagi. Dihapus dari keranjang.')
  }
  for (const id of invalidPhysicalPromotionIds(state)) {
    push({ type: 'REMOVE_PROMOTION', id })
    notes.push('Promo tidak berlaku lagi (syarat barang berubah). Dihapus dari keranjang.')
  }
  if (held.loyaltyDropped) notes.push('Poin dan Hadiah loyalti perlu dipilih ulang')

  return { actions, notes, result: state, lossless: retired.length === 0 }
}
