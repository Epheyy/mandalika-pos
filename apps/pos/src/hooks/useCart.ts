/**
 * Cart add/remove/qty + provisional pricing mirror of CashierScreen.tsx:320-389.
 * DISPLAY ONLY — server recomputes everything on flush.
 */

import { useCallback } from 'react'
import type { components } from '@mandalika/api'
import type { CashierAction, CashierState } from '../cashier/state/cashierReducer'
import { computePricing } from '../cashier/pricing'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']
type AppSettings = components['schemas']['AppSettings']
type LoyaltySettings = components['schemas']['LoyaltySettings']

interface UseCartOptions {
  state: CashierState
  dispatch: React.Dispatch<CashierAction>
  settings: AppSettings
  loyalty: LoyaltySettings
}

export interface CartActions {
  addVariants: (
    product: Product,
    variantQtys: Record<string, number>,
  ) => void
  removeItem: (productId: string, variantSize: string) => void
  setQty: (productId: string, variantSize: string, qty: number) => void
  clearCart: () => void
  applyDiscount: () => void
  applySurcharge: () => void
}

export interface CartDerived {
  subtotal: number
  manualDiscountAmount: number
  promoDiscountAmount: number
  discountAmount: number
  taxableAmount: number
  taxAmount: number
  surchargeAmount: number
  redeemAmount: number
  redeemedPoints: number
  total: number
  earnedPoints: number
  totalCartItems: number
}

export function useCart(opts: UseCartOptions): {
  actions: CartActions
  derived: CartDerived
} {
  const { state, dispatch, settings, loyalty } = opts

  const pricing = computePricing({
    cart: state.cart,
    discountType: state.appliedDiscountType,
    surchargeType: state.appliedSurchargeType,
    discountRunning: state.discountRunning,
    surchargeRunning: state.surchargeRunning,
    appliedPromotions: state.appliedPromotions,
    appliedPromoCodes: state.appliedPromoCodes,
    settings,
    loyalty,
    hasCustomer: state.selectedCustomer !== null,
    pointsRedeemed: state.pointsToRedeem,
    customerPoints: state.selectedCustomer?.points ?? 0,
  })

  const totalCartItems = state.cart.reduce((s: number, i: CartItem) => s + i.quantity, 0)

  const addVariants = useCallback(
    (product: Product, variantQtys: Record<string, number>) => {
      product.variants.forEach((variant) => {
        const qty = variantQtys[variant.size] || 0
        if (qty === 0) return
        const item: CartItem = {
          productId: product.id,
          productName: product.name,
          variantSize: variant.size,
          price: variant.price,
          quantity: qty,
          subtotal: Math.round(variant.price * qty),
        }
        dispatch({ type: 'CART_ADD_ITEM', item })
      })
    },
    [dispatch],
  )

  const removeItem = useCallback(
    (productId: string, variantSize: string) => {
      dispatch({ type: 'CART_REMOVE_ITEM', productId, variantSize })
    },
    [dispatch],
  )

  const setQty = useCallback(
    (productId: string, variantSize: string, quantity: number) => {
      dispatch({ type: 'CART_SET_QTY', productId, variantSize, quantity })
    },
    [dispatch],
  )

  const clearCart = useCallback(() => {
    dispatch({ type: 'CART_CLEAR' })
  }, [dispatch])

  const applyDiscount = useCallback(() => {
    const val = parseFloat(state.adjustInputStr) || 0
    if (val <= 0) return
    dispatch({ type: 'APPLY_DISCOUNT', value: val })
  }, [dispatch, state.adjustInputStr])

  const applySurcharge = useCallback(() => {
    const val = parseFloat(state.adjustInputStr) || 0
    if (val <= 0) return
    dispatch({ type: 'APPLY_SURCHARGE', value: val })
  }, [dispatch, state.adjustInputStr])

  return {
    actions: {
      addVariants,
      removeItem,
      setQty,
      clearCart,
      applyDiscount,
      applySurcharge,
    },
    derived: {
      ...pricing,
      totalCartItems,
    },
  }
}
