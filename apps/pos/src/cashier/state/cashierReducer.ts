/**
 * Consolidates cart / discount / surcharge / customer / promo / payment state
 * that was previously spread across ~40 useState calls in CashierScreen.tsx.
 * Pure reducer + typed actions — no side effects here.
 */

import { promotionHasKeyOverlap } from '@mandalika/types'
import type { components } from '@mandalika/api'
export type { AppliedPromoCode } from '../promoValidate'
import type { AppliedPromoCode } from '../promoValidate'
import type { BundleFreedUnit } from '../bundle'
import { addTenderLine, type TenderLine } from '../tenderSplit'
import { upsertCartItem, reducePaidQty, restoreBundle, restoreAllBundles, omitKey, clearBundleEntry, evictAllForExclusive, removePromotionEffect } from '../promotionEffects'
import { planPromotionFulfillment, type PromotionOwner, type FulfillmentChoice } from '../promotionFulfillment'
import { effectivePromotionSelection, isRedundantPromoCode } from '../promotionSelection'

type CartItem = components['schemas']['CartItem']
type Customer = components['schemas']['Customer']
type Promotion = components['schemas']['Promotion']
type PaymentMethod = string

export interface CashierState {
  // Cart
  cart: CartItem[]
  // Customer
  selectedCustomer: Customer | null
  customerSearch: string
  // Salesman (staff attributed to the sale)
  selectedSalesman: { id: string; name: string } | null
  // Loyalty points the customer redeems on this order
  pointsToRedeem: number
  // Adjustments
  // `discountType` is the *staged* segmented selection (what the input box
  // means right now). The `applied*Type` fields capture the kind at the moment
  // an adjustment was applied, so toggling the segmented control afterwards
  // never retroactively reinterprets an already-applied value.
  discountType: 'percentage' | 'fixed'
  appliedDiscountType: 'percentage' | 'fixed'
  appliedSurchargeType: 'percentage' | 'fixed'
  discountRunning: number
  surchargeRunning: number
  orderNotes: string
  activeAdjustment: 'notes' | 'discount' | 'promo' | null
  adjustInputStr: string
  // Promotions
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  promoCodeInput: string
  // Applied bundles' freed sets, keyed by bundle promotion id. A bundle MOVES
  // units paid→reward (reducing the paid line), unlike bxgy/loyalty rewards which
  // ADD extra units. Retaining the freed set (with fullPrice) lets EVERY reward-
  // strip path restore the moved paid quantity, so freed physical units never
  // vanish (stock conservation). A reward line whose rewardPromotionId is a key
  // here is a bundle line → restore; otherwise strip as before.
  bundleFreed: Record<string, BundleFreedUnit[]>
  // Applied nApp per bundle promotion id — the number of complete bundle
  // applications the bundle was applied at. Kept in LOCK-STEP with bundleFreed
  // (an id is in both maps or neither). The reactive-removal effect compares the
  // currently-owned nApp against this to catch anchor-qty reductions in
  // multi-application combos, which leave bundleFreed over-applied.
  bundleApplications: Record<string, number>
  // Checkout
  isCheckoutOpen: boolean
  paymentMethod: PaymentMethod
  amountPaid: string
  /** C6: optional "No. referensi" typed for the next/only non-cash line. */
  tenderReference: string
  /** C6: the sheet is in split mode; `tenders` are the entered payment lines (never stored in a held order, D-64). */
  splitMode: boolean
  tenders: TenderLine[]
  /** C6 D-62: the sale's order uuid, minted when split mode starts so a saved draft and the queued sale share one key. */
  splitOrderUuid: string | null
  isProcessing: boolean
  lastOrderId: string | null
  /** The reserved order number of the sale just completed (what is printed). */
  lastOrderNumber: string | null
  isSuccessOpen: boolean
  // UI prefs
  activeTab: 'products' | 'cart'
}

export type CashierAction =
  | { type: 'CART_ADD_ITEM'; item: CartItem }
  | { type: 'CART_REMOVE_ITEM'; productId: string; variantSize: string }
  | { type: 'CART_SET_QTY'; productId: string; variantSize: string; quantity: number }
  | { type: 'CART_ADD_REWARD'; item: CartItem & { isReward: true; rewardConditionId?: string; rewardPromotionId?: string } }
  | { type: 'CART_REMOVE_REWARD'; rewardConditionId: string }
  | { type: 'CART_REMOVE_PROMO_REWARDS'; rewardPromotionId: string }
  | { type: 'APPLY_BUNDLE'; promotion: Promotion; freed: BundleFreedUnit[]; applications: number }
  | { type: 'APPLY_FULFILLMENT'; owner: PromotionOwner; products: components['schemas']['Product'][]; choice?: FulfillmentChoice }
  | { type: 'REMOVE_BUNDLE'; promotionId: string; freed: BundleFreedUnit[] }
  | { type: 'CART_CLEAR' }
  | { type: 'SET_CUSTOMER'; customer: Customer | null }
  | { type: 'SET_CUSTOMER_SEARCH'; search: string }
  | { type: 'SET_SALESMAN'; salesman: { id: string; name: string } | null }
  | { type: 'SET_POINTS_REDEEMED'; points: number }
  | { type: 'SET_DISCOUNT_TYPE'; discountType: 'percentage' | 'fixed' }
  | { type: 'APPLY_DISCOUNT'; value: number }
  | { type: 'APPLY_SURCHARGE'; value: number }
  | { type: 'CLEAR_DISCOUNT' }
  | { type: 'SET_ORDER_NOTES'; notes: string }
  | { type: 'SET_ACTIVE_ADJUSTMENT'; panel: CashierState['activeAdjustment'] }
  | { type: 'SET_ADJUST_INPUT'; value: string }
  | { type: 'SET_PROMO_CODE_INPUT'; value: string }
  | { type: 'APPLY_PROMO_CODE'; code: AppliedPromoCode; combinable: boolean }
  | { type: 'APPLY_PROMOTION'; promotion: Promotion }
  | { type: 'REMOVE_PROMOTION'; id: string }
  | { type: 'REMOVE_PROMO_CODE'; code: string }
  | { type: 'CLEAR_PROMOTIONS' }
  | { type: 'OPEN_CHECKOUT'; defaultMethod: PaymentMethod }
  | { type: 'CLOSE_CHECKOUT' }
  | { type: 'SET_PAYMENT_METHOD'; method: PaymentMethod }
  | { type: 'SET_AMOUNT_PAID'; amount: string }
  | { type: 'SET_TENDER_REFERENCE'; reference: string }
  | { type: 'SPLIT_START'; orderUuid: string }
  /** Adds one line (cap at Sisa, cash merged into the cash line, N lines); an unacceptable line leaves the state as it was. */
  | { type: 'TENDER_ADD'; line: TenderLine; due: number; isCash: (method: string) => boolean }
  | { type: 'TENDER_REMOVE'; index: number }
  | { type: 'SPLIT_CANCEL' }
  /** D-62: reopen the sheet with the lines of a restored draft (dispatched after OPEN_CHECKOUT). */
  | { type: 'SPLIT_RESTORE'; orderUuid: string; tenders: TenderLine[] }
  | { type: 'SET_PROCESSING'; processing: boolean }
  | { type: 'ORDER_SUCCESS'; orderId: string; orderNumber?: string }
  | { type: 'CLOSE_SUCCESS' }
  | { type: 'SET_ACTIVE_TAB'; tab: 'products' | 'cart' }
  | { type: 'RESET_SALE' }

/** What leaves the state whenever the checkout sheet closes, a sale completes or the sale resets. */
const NO_SPLIT = { splitMode: false, tenders: [] as TenderLine[], splitOrderUuid: null, tenderReference: '' }

export const CASHIER_INITIAL_STATE: CashierState = {
  cart: [],
  selectedCustomer: null,
  customerSearch: '',
  selectedSalesman: null,
  pointsToRedeem: 0,
  discountType: 'fixed',
  appliedDiscountType: 'fixed',
  appliedSurchargeType: 'fixed',
  discountRunning: 0,
  surchargeRunning: 0,
  orderNotes: '',
  activeAdjustment: null,
  adjustInputStr: '',
  appliedPromotions: [],
  appliedPromoCodes: [],
  promoCodeInput: '',
  bundleFreed: {},
  bundleApplications: {},
  isCheckoutOpen: false,
  paymentMethod: 'cash',
  amountPaid: '',
  tenderReference: '',
  splitMode: false,
  tenders: [],
  splitOrderUuid: null,
  isProcessing: false,
  lastOrderId: null,
  lastOrderNumber: null,
  isSuccessOpen: false,
  activeTab: 'products',
}

// A non-combinable discount is exclusive: its presence (existing or incoming)
// forces the set to a single member.
function hasNonCombinablePromotion(promotions: Promotion[]): boolean {
  return promotions.some((p) => !p.combinable)
}

// bundlesContainingKey: ids of applied bundles whose FREED set includes a unit
// matching (productId, variantSize). Catalog-free — reads only the stored freed
// set. Used to evict a bundle before a cart edit touches one of its participants.
function bundlesContainingKey(
  bundleFreed: Record<string, BundleFreedUnit[]>,
  productId: string,
  variantSize: string,
): string[] {
  return Object.entries(bundleFreed)
    .filter(([, freed]) =>
      freed.some((f) => f.productId === productId && f.variantSize === variantSize),
    )
    .map(([id]) => id)
}

// evictBundlesForKey: remove every applied bundle whose freed set contains the
// edited key BEFORE a CART_REMOVE_ITEM / CART_SET_QTY is applied. Restores each
// bundle's moved units to paid, strips its reward lines, drops it from
// appliedPromotions, and clears its bundleFreed entry — so no stale freed entry
// survives the edit (which would let a later strip over-restore). Returns the
// pieces of state that change; no-op passthrough when no bundle owns the key.
function evictBundlesForKey(
  state: CashierState,
  productId: string,
  variantSize: string,
): Pick<CashierState, 'cart' | 'appliedPromotions' | 'appliedPromoCodes' | 'bundleFreed' | 'bundleApplications'> {
  const ids = bundlesContainingKey(state.bundleFreed, productId, variantSize)
  if (ids.length === 0) {
    return {
      cart: state.cart,
      appliedPromotions: state.appliedPromotions,
      appliedPromoCodes: state.appliedPromoCodes,
      bundleFreed: state.bundleFreed,
      bundleApplications: state.bundleApplications,
    }
  }
  let cart = state.cart
  let bundleFreed = state.bundleFreed
  let bundleApplications = state.bundleApplications
  let appliedPromotions = state.appliedPromotions
  let appliedPromoCodes = state.appliedPromoCodes
  for (const id of ids) {
    cart = restoreBundle(cart, id, bundleFreed[id])
    bundleFreed = omitKey(bundleFreed, id)
    bundleApplications = omitKey(bundleApplications, id)
    appliedPromotions = appliedPromotions.filter((p) => p.id !== id)
    appliedPromoCodes = appliedPromoCodes.filter((c) => c.promotion?.id !== id)
  }
  return { cart, appliedPromotions, appliedPromoCodes, bundleFreed, bundleApplications }
}

export function cashierReducer(
  state: CashierState,
  action: CashierAction,
): CashierState {
  // Drop redundant draft selections before removal as well as application, so
  // removing a winner cannot revive a hidden code. Cart ownership is unchanged.
  const effective = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
  if (effective.appliedPromotions !== state.appliedPromotions || effective.appliedPromoCodes !== state.appliedPromoCodes) {
    state = { ...state, ...effective }
  }
  switch (action.type) {
    case 'APPLY_FULFILLMENT': {
      const plan = planPromotionFulfillment(state, action.owner, action.products, action.choice)
      return plan.kind === 'ready' ? plan.next : state
    }
    case 'CART_ADD_ITEM':
      return { ...state, cart: upsertCartItem(state.cart, action.item) }

    case 'CART_ADD_REWARD': {
      const { rewardConditionId, rewardPromotionId } = action.item
      if (rewardPromotionId) {
        // promo reward: keyed by (rewardPromotionId, productId, variantSize) — multiple
        // lines per promo are allowed (each pick appends a distinct variant line).
        // Re-picking the same (promo, product, variant) triple replaces that line.
        const without = state.cart.filter(
          (c) =>
            !(
              c.isReward &&
              c.rewardPromotionId === rewardPromotionId &&
              c.productId === action.item.productId &&
              c.variantSize === action.item.variantSize
            ),
        )
        return { ...state, cart: [...without, action.item] }
      }
      // loyalty reward: one free line per condition; re-picking replaces it. Never merges with paid.
      const without = state.cart.filter(
        (c) => !(c.isReward && c.rewardConditionId === rewardConditionId),
      )
      return { ...state, cart: [...without, action.item] }
    }

    case 'CART_REMOVE_REWARD':
      return {
        ...state,
        cart: state.cart.filter(
          (c) => !(c.isReward && c.rewardConditionId === action.rewardConditionId),
        ),
      }

    case 'CART_REMOVE_PROMO_REWARDS':
      if (state.appliedPromoCodes.some(c => c.promotion?.id === action.rewardPromotionId)) {
        return removePromotionEffect(state, action.rewardPromotionId)
      }
      return {
        ...state,
        cart: state.cart.filter(
          (c) => !(c.isReward && c.rewardPromotionId === action.rewardPromotionId),
        ),
      }

    case 'APPLY_BUNDLE': {
      if (promotionHasKeyOverlap(action.promotion)) return state
      if (state.appliedPromoCodes.some(c => c.promotion?.id === action.promotion.id)) {
        state = removePromotionEffect(state, action.promotion.id)
      }
      state = { ...state, appliedPromoCodes: state.appliedPromoCodes.filter(c => c.promotion?.id !== action.promotion.id) }
      // Reprice the cheapest consumed units into reward lines: reduce each
      // matching PAID line by the freed qty (dropping it at 0) and add an
      // isReward line at the bundleAllocate net. Stock-conserving — a freed unit
      // is MOVED from paid to reward, never added, so paidQty+rewardQty is
      // unchanged for every (productId, variantSize).
      let cart = state.cart
      for (const f of action.freed) {
        cart = reducePaidQty(cart, f.productId, f.variantSize, f.quantity)
        cart = [
          ...cart,
          {
            productId: f.productId,
            productName: f.productName,
            variantSize: f.variantSize,
            price: f.net,
            quantity: f.quantity,
            subtotal: Math.round(f.net * f.quantity),
            isReward: true,
            rewardPromotionId: action.promotion.id,
          },
        ]
      }
      const already = state.appliedPromotions.some((p) => p.id === action.promotion.id)
      return {
        ...state,
        cart,
        appliedPromotions: already
          ? state.appliedPromotions
          : [...state.appliedPromotions, action.promotion],
        // Retain the freed set so any later reward-strip path can restore the
        // moved paid quantity (stock conservation), plus the applied nApp so the
        // reactive-removal effect can detect an over-applied (anchor-reduced) cart.
        bundleFreed: { ...state.bundleFreed, [action.promotion.id]: action.freed },
        bundleApplications: { ...state.bundleApplications, [action.promotion.id]: action.applications },
        activeAdjustment: null,
      }
    }

    case 'REMOVE_BUNDLE':
      return removePromotionEffect(state, action.promotionId)

    case 'CART_REMOVE_ITEM': {
      // If this key participates in an applied bundle's freed set, remove that
      // bundle first (restore its units + clear its entry) so no stale
      // bundleFreed survives the delete and a later strip cannot over-restore.
      const base = evictBundlesForKey(state, action.productId, action.variantSize)
      return {
        ...state,
        ...base,
        cart: base.cart.filter(
          (c) =>
            !(
              c.productId === action.productId &&
              c.variantSize === action.variantSize &&
              !c.isReward
            ),
        ),
      }
    }

    case 'CART_SET_QTY': {
      // Same bundle-eviction guard as CART_REMOVE_ITEM: normalize first, then edit.
      const base = evictBundlesForKey(state, action.productId, action.variantSize)
      if (action.quantity <= 0) {
        return {
          ...state,
          ...base,
          cart: base.cart.filter(
            (c) =>
              !(
                c.productId === action.productId &&
                c.variantSize === action.variantSize &&
                !c.isReward
              ),
          ),
        }
      }
      return {
        ...state,
        ...base,
        cart: base.cart.map((c) =>
          c.productId === action.productId &&
          c.variantSize === action.variantSize &&
          !c.isReward
            ? {
                ...c,
                quantity: action.quantity,
                subtotal: Math.round(action.quantity * c.price),
              }
            : c,
        ),
      }
    }

    case 'CART_CLEAR':
      return {
        ...state,
        cart: [],
        selectedCustomer: null,
        customerSearch: '',
        selectedSalesman: null,
        pointsToRedeem: 0,
        orderNotes: '',
        discountRunning: 0,
        surchargeRunning: 0,
        adjustInputStr: '',
        appliedPromoCodes: [],
        appliedPromotions: [],
        bundleFreed: {},
        bundleApplications: {},
        activeAdjustment: null,
      }

    case 'SET_CUSTOMER': {
      // Reward eligibility is customer-specific; drop reward lines on change/clear.
      // But a bundle MOVED units off their paid line — restore those to paid first
      // (else the freed physical units vanish = stock leak), then strip the
      // remaining (bxgy/loyalty) reward lines which were added extras.
      const restored = restoreAllBundles(state.cart, state.bundleFreed)
      return {
        ...state,
        selectedCustomer: action.customer,
        customerSearch: action.customer ? '' : state.customerSearch,
        // Points belong to a customer; drop redemption when they change/clear.
        pointsToRedeem: 0,
        cart: restored.filter((c) => !c.isReward),
        // Restored bundles are no longer applied; drop them + clear their freed set.
        appliedPromotions: state.appliedPromotions.filter((p) => !(p.id in state.bundleFreed)),
        appliedPromoCodes: state.appliedPromoCodes.filter(c => !c.promotion ||
          (c.promotion.type !== 'bundle' && !(c.promotion.type === 'buy_x_get_y' && (c.promotion.bxgyConfig?.getProductIds ?? []).length > 0))),
        bundleFreed: {},
        bundleApplications: {},
      }
    }

    case 'SET_CUSTOMER_SEARCH':
      return { ...state, customerSearch: action.search }

    case 'SET_SALESMAN':
      return { ...state, selectedSalesman: action.salesman }

    case 'SET_POINTS_REDEEMED':
      return { ...state, pointsToRedeem: Math.max(0, Math.floor(action.points)) }

    case 'SET_DISCOUNT_TYPE':
      return { ...state, discountType: action.discountType }

    case 'APPLY_DISCOUNT':
      // Replace (not accumulate) and snapshot the staged kind. Replacing avoids
      // mixing %/Rp values into one meaningless running number.
      return {
        ...state,
        discountRunning: action.value,
        appliedDiscountType: state.discountType,
        adjustInputStr: '',
      }

    case 'APPLY_SURCHARGE':
      return {
        ...state,
        surchargeRunning: action.value,
        appliedSurchargeType: state.discountType,
        adjustInputStr: '',
      }

    case 'CLEAR_DISCOUNT':
      return {
        ...state,
        discountRunning: 0,
        surchargeRunning: 0,
        adjustInputStr: '',
      }

    case 'SET_ORDER_NOTES':
      return { ...state, orderNotes: action.notes }

    case 'SET_ACTIVE_ADJUSTMENT':
      return { ...state, activeAdjustment: action.panel }

    case 'SET_ADJUST_INPUT':
      return { ...state, adjustInputStr: action.value }

    case 'SET_PROMO_CODE_INPUT':
      return { ...state, promoCodeInput: action.value }

    case 'APPLY_PROMOTION': {
      if (promotionHasKeyOverlap(action.promotion)) return state
      // Direct identity wins before testing exclusivity against unrelated offers.
      // A physical code-owned effect must be undone before direct installation.
      // The screen uses APPLY_FULFILLMENT to recompute and commit physical takeover.
      if (state.appliedPromoCodes.some(c => c.promotion?.id === action.promotion.id)) {
        state = removePromotionEffect(state, action.promotion.id)
      }
      state = { ...state, appliedPromoCodes: state.appliedPromoCodes.filter(c => c.promotion?.id !== action.promotion.id) }
      const exists = state.appliedPromotions.some((p) => p.id === action.promotion.id)
      if (exists) {
        // toggle off — strip this promo's reward lines. A bundle MOVED units off
        // their paid line, so restore the paid quantity instead of just dropping
        // the reward (else the freed units vanish). Bxgy/loyalty rewards were
        // added extras → plain strip.
        const freed = state.bundleFreed[action.promotion.id]
        const cart = freed
          ? restoreBundle(state.cart, action.promotion.id, freed)
          : state.cart.filter(
              (c) => !(c.isReward && c.rewardPromotionId === action.promotion.id),
            )
        return {
          ...state,
          appliedPromotions: state.appliedPromotions.filter((p) => p.id !== action.promotion.id),
          cart,
          ...clearBundleEntry(state, action.promotion.id),
          activeAdjustment: null,
        }
      }
      const incomingExclusive = !action.promotion.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      if (incomingExclusive || currentExclusive) {
        // Replace the whole set. Restore any evicted bundle's moved units + clear
        // its bundleFreed first (else ghost Rp0 reward lines + a stale entry linger).
        return {
          ...state,
          ...evictAllForExclusive(state),
          appliedPromotions: [action.promotion],
          appliedPromoCodes: [],
          activeAdjustment: null,
        }
      }
      return {
        ...state,
        appliedPromotions: [...state.appliedPromotions, action.promotion],
        activeAdjustment: null,
      }
    }

    case 'APPLY_PROMO_CODE': {
      if (action.code.promotion && promotionHasKeyOverlap(action.code.promotion)) return state
      if (isRedundantPromoCode(state.appliedPromotions, state.appliedPromoCodes, action.code)) {
        return { ...state, promoCodeInput: '', activeAdjustment: null }
      }
      const incomingExclusive = !action.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      const code: AppliedPromoCode = { ...action.code, combinable: action.combinable }
      if (incomingExclusive || currentExclusive) {
        // Twin of APPLY_PROMOTION's exclusive branch — restore any evicted bundle
        // before replacing the set so the moved units + bundleFreed don't leak.
        return {
          ...state,
          ...evictAllForExclusive(state),
          appliedPromotions: [],
          appliedPromoCodes: [code],
          promoCodeInput: '',
          activeAdjustment: null,
        }
      }
      return {
        ...state,
        appliedPromoCodes: [...state.appliedPromoCodes, code],
        promoCodeInput: '',
        activeAdjustment: null,
      }
    }

    case 'REMOVE_PROMOTION':
      return removePromotionEffect(state, action.id)

    case 'REMOVE_PROMO_CODE': {
      const selected = state.appliedPromoCodes.find(c => c.code === action.code)
      if (selected?.promotion) return removePromotionEffect(state, selected.promotion.id)
      return { ...state, appliedPromoCodes: state.appliedPromoCodes.filter((c) => c.code !== action.code) }
    }

    case 'CLEAR_PROMOTIONS': {
      // Restore every applied bundle's paid quantity first (their units were
      // MOVED off paid — plain stripping would leak stock), then strip ALL
      // remaining promo reward lines (keeps loyalty rewards, which have a
      // rewardConditionId and no rewardPromotionId).
      const restored = restoreAllBundles(state.cart, state.bundleFreed)
      return {
        ...state,
        appliedPromotions: [],
        appliedPromoCodes: [],
        promoCodeInput: '',
        cart: restored.filter((c) => !(c.isReward && c.rewardPromotionId)),
        bundleFreed: {},
        bundleApplications: {},
      }
    }

    case 'OPEN_CHECKOUT':
      return {
        ...state,
        isCheckoutOpen: true,
        paymentMethod: action.defaultMethod,
        amountPaid: '',
        ...NO_SPLIT,
      }

    case 'CLOSE_CHECKOUT':
      return { ...state, isCheckoutOpen: false, ...NO_SPLIT }

    case 'SET_PAYMENT_METHOD':
      return { ...state, paymentMethod: action.method }

    case 'SET_AMOUNT_PAID':
      return { ...state, amountPaid: action.amount }

    case 'SET_TENDER_REFERENCE':
      return { ...state, tenderReference: action.reference }

    case 'SPLIT_START':
      return { ...state, splitMode: true, tenders: [], amountPaid: '', tenderReference: '', splitOrderUuid: action.orderUuid }

    case 'TENDER_ADD': {
      const added = addTenderLine(state.tenders, action.line, action.due, action.isCash)
      if (!added.ok) return state
      return { ...state, tenders: added.lines, amountPaid: '', tenderReference: '' }
    }

    case 'TENDER_REMOVE':
      return { ...state, tenders: state.tenders.filter((_, i) => i !== action.index) }

    case 'SPLIT_CANCEL':
      return { ...state, ...NO_SPLIT, amountPaid: '' }

    case 'SPLIT_RESTORE':
      return { ...state, splitMode: true, tenders: action.tenders, splitOrderUuid: action.orderUuid, amountPaid: '', tenderReference: '' }

    case 'SET_PROCESSING':
      return { ...state, isProcessing: action.processing }

    case 'ORDER_SUCCESS':
      return {
        ...state,
        lastOrderId: action.orderId,
        lastOrderNumber: action.orderNumber || null,
        isCheckoutOpen: false,
        isSuccessOpen: true,
        isProcessing: false,
        ...NO_SPLIT,
      }

    case 'CLOSE_SUCCESS':
      // Closing the success modal (either "Tutup" or "Transaksi Baru") starts
      // a clean sale — cart, customer, discount, promo, notes all cleared.
      return {
        ...CASHIER_INITIAL_STATE,
        activeTab: state.activeTab,
      }

    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab }

    case 'RESET_SALE': {
      return {
        ...CASHIER_INITIAL_STATE,
        // preserve user prefs
        activeTab: state.activeTab,
      }
    }

    default:
      return state
  }
}
