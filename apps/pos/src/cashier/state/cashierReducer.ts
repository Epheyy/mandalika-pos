/**
 * Consolidates cart / discount / surcharge / customer / promo / payment state
 * that was previously spread across ~40 useState calls in CashierScreen.tsx.
 * Pure reducer + typed actions — no side effects here.
 */

import type { components } from '@mandalika/api'
export type { AppliedPromoCode } from '../promoValidate'
import type { AppliedPromoCode } from '../promoValidate'
import type { BundleFreedUnit } from '../bundle'

type CartItem = components['schemas']['CartItem']
type Customer = components['schemas']['Customer']
type Promotion = components['schemas']['Promotion']
type PaymentMethod = 'cash' | 'card' | 'transfer' | 'qris'

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
  // Checkout
  isCheckoutOpen: boolean
  paymentMethod: PaymentMethod
  amountPaid: string
  isProcessing: boolean
  lastOrderId: string | null
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
  | { type: 'APPLY_BUNDLE'; promotion: Promotion; freed: BundleFreedUnit[] }
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
  | { type: 'SET_PROCESSING'; processing: boolean }
  | { type: 'ORDER_SUCCESS'; orderId: string }
  | { type: 'CLOSE_SUCCESS' }
  | { type: 'SET_ACTIVE_TAB'; tab: 'products' | 'cart' }
  | { type: 'RESET_SALE' }

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
  isCheckoutOpen: false,
  paymentMethod: 'cash',
  amountPaid: '',
  isProcessing: false,
  lastOrderId: null,
  isSuccessOpen: false,
  activeTab: 'products',
}

// A non-combinable discount is exclusive: its presence (existing or incoming)
// forces the set to a single member.
function hasNonCombinablePromotion(promotions: Promotion[]): boolean {
  return promotions.some((p) => !p.combinable)
}

function upsertCartItem(cart: CartItem[], item: CartItem): CartItem[] {
  const idx = cart.findIndex(
    (c) =>
      c.productId === item.productId &&
      c.variantSize === item.variantSize &&
      !c.isReward,
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
function reducePaidQty(
  cart: CartItem[],
  productId: string,
  variantSize: string,
  dec: number,
): CartItem[] {
  return cart.flatMap((c) => {
    if (c.isReward || c.productId !== productId || c.variantSize !== variantSize) return [c]
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
function restoreBundle(
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
function restoreAllBundles(
  cart: CartItem[],
  bundleFreed: Record<string, BundleFreedUnit[]>,
): CartItem[] {
  let next = cart
  for (const [promotionId, freed] of Object.entries(bundleFreed)) {
    next = restoreBundle(next, promotionId, freed)
  }
  return next
}

// omitKey: return a shallow copy of the map without `key` (immutable delete).
function omitKey(
  map: Record<string, BundleFreedUnit[]>,
  key: string,
): Record<string, BundleFreedUnit[]> {
  if (!(key in map)) return map
  const { [key]: _removed, ...rest } = map
  return rest
}

export function cashierReducer(
  state: CashierState,
  action: CashierAction,
): CashierState {
  switch (action.type) {
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
      return {
        ...state,
        cart: state.cart.filter(
          (c) => !(c.isReward && c.rewardPromotionId === action.rewardPromotionId),
        ),
      }

    case 'APPLY_BUNDLE': {
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
        // moved paid quantity (stock conservation).
        bundleFreed: { ...state.bundleFreed, [action.promotion.id]: action.freed },
        activeAdjustment: null,
      }
    }

    case 'REMOVE_BUNDLE': {
      // Inverse of APPLY_BUNDLE: strip this bundle's reward lines and restore the
      // freed units back onto their paid lines at full price. Prefer the retained
      // freed set (source of truth) and fall back to the action's for safety.
      const freed = state.bundleFreed[action.promotionId] ?? action.freed
      return {
        ...state,
        cart: restoreBundle(state.cart, action.promotionId, freed),
        appliedPromotions: state.appliedPromotions.filter((p) => p.id !== action.promotionId),
        bundleFreed: omitKey(state.bundleFreed, action.promotionId),
      }
    }

    case 'CART_REMOVE_ITEM':
      return {
        ...state,
        cart: state.cart.filter(
          (c) =>
            !(
              c.productId === action.productId &&
              c.variantSize === action.variantSize &&
              !c.isReward
            ),
        ),
      }

    case 'CART_SET_QTY': {
      if (action.quantity <= 0) {
        return {
          ...state,
          cart: state.cart.filter(
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
        cart: state.cart.map((c) =>
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
        bundleFreed: {},
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
          bundleFreed: omitKey(state.bundleFreed, action.promotion.id),
          activeAdjustment: null,
        }
      }
      const incomingExclusive = !action.promotion.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      if (incomingExclusive || currentExclusive) {
        return {
          ...state,
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
      const exists = state.appliedPromoCodes.some((c) => c.code === action.code.code)
      if (exists) {
        return { ...state, promoCodeInput: '', activeAdjustment: null }
      }
      const incomingExclusive = !action.combinable
      const currentExclusive =
        hasNonCombinablePromotion(state.appliedPromotions) ||
        state.appliedPromoCodes.some((c) => !c.combinable)
      const code: AppliedPromoCode = { ...action.code, combinable: action.combinable }
      if (incomingExclusive || currentExclusive) {
        return {
          ...state,
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

    case 'REMOVE_PROMOTION': {
      // strip the reward lines this promo gave, so they don't linger when removed.
      // A bundle MOVED units off their paid line → restore the paid quantity;
      // bxgy/loyalty rewards were added extras → plain strip.
      const freed = state.bundleFreed[action.id]
      const cart = freed
        ? restoreBundle(state.cart, action.id, freed)
        : state.cart.filter((c) => !(c.isReward && c.rewardPromotionId === action.id))
      return {
        ...state,
        appliedPromotions: state.appliedPromotions.filter((p) => p.id !== action.id),
        cart,
        bundleFreed: omitKey(state.bundleFreed, action.id),
      }
    }

    case 'REMOVE_PROMO_CODE':
      return { ...state, appliedPromoCodes: state.appliedPromoCodes.filter((c) => c.code !== action.code) }

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
      }
    }

    case 'OPEN_CHECKOUT':
      return {
        ...state,
        isCheckoutOpen: true,
        paymentMethod: action.defaultMethod,
        amountPaid: '',
      }

    case 'CLOSE_CHECKOUT':
      return { ...state, isCheckoutOpen: false }

    case 'SET_PAYMENT_METHOD':
      return { ...state, paymentMethod: action.method }

    case 'SET_AMOUNT_PAID':
      return { ...state, amountPaid: action.amount }

    case 'SET_PROCESSING':
      return { ...state, isProcessing: action.processing }

    case 'ORDER_SUCCESS':
      return {
        ...state,
        lastOrderId: action.orderId,
        isCheckoutOpen: false,
        isSuccessOpen: true,
        isProcessing: false,
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
