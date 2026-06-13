/**
 * Consolidates cart / discount / surcharge / customer / promo / payment state
 * that was previously spread across ~40 useState calls in CashierScreen.tsx.
 * Pure reducer + typed actions — no side effects here.
 */

import type { components } from '@mandalika/api'
export type { AppliedPromoCode } from '../promoValidate'
import type { AppliedPromoCode } from '../promoValidate'

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
  appliedPromotion: Promotion | null
  appliedPromoCode: AppliedPromoCode | null
  promoCodeInput: string
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
  | { type: 'CART_ADD_REWARD'; item: CartItem & { isReward: true; rewardConditionId: string } }
  | { type: 'CART_REMOVE_REWARD'; rewardConditionId: string }
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
  | { type: 'APPLY_PROMO_CODE'; code: AppliedPromoCode }
  | { type: 'APPLY_PROMOTION'; promotion: Promotion }
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
  appliedPromotion: null,
  appliedPromoCode: null,
  promoCodeInput: '',
  isCheckoutOpen: false,
  paymentMethod: 'cash',
  amountPaid: '',
  isProcessing: false,
  lastOrderId: null,
  isSuccessOpen: false,
  activeTab: 'products',
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

export function cashierReducer(
  state: CashierState,
  action: CashierAction,
): CashierState {
  switch (action.type) {
    case 'CART_ADD_ITEM':
      return { ...state, cart: upsertCartItem(state.cart, action.item) }

    case 'CART_ADD_REWARD': {
      // One free line per condition; re-picking replaces it. Never merges with paid.
      const without = state.cart.filter(
        (c) => !(c.isReward && c.rewardConditionId === action.item.rewardConditionId),
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
        appliedPromoCode: null,
        appliedPromotion: null,
        activeAdjustment: null,
      }

    case 'SET_CUSTOMER':
      return {
        ...state,
        selectedCustomer: action.customer,
        customerSearch: action.customer ? '' : state.customerSearch,
        // Points belong to a customer; drop redemption when they change/clear.
        pointsToRedeem: 0,
        // Reward eligibility is customer-specific; drop reward lines on change/clear.
        cart: state.cart.filter((c) => !c.isReward),
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

    case 'APPLY_PROMO_CODE':
      return {
        ...state,
        appliedPromoCode: action.code,
        appliedPromotion: null,
        promoCodeInput: '',
        activeAdjustment: null,
      }

    case 'APPLY_PROMOTION':
      return {
        ...state,
        appliedPromotion: action.promotion,
        appliedPromoCode: null,
        activeAdjustment: null,
      }

    case 'CLEAR_PROMOTIONS':
      return {
        ...state,
        appliedPromotion: null,
        appliedPromoCode: null,
        promoCodeInput: '',
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
