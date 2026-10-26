/**
 * Renders the three adjustment panels (notes, discount, promo) as floating modals.
 * Extracted from CashierScreen to keep the orchestrator lean.
 */

import { memo } from 'react'
import type { components } from '@mandalika/api'
import type { CashierState, CashierAction } from './state/cashierReducer'
import { PromoPanel } from './PromoPanel'
import { promotionPreviewCart } from './promotionFulfillment'
import { Sheet } from '../components/ui/Sheet'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

interface AdjustmentDrawerProps {
  state: CashierState
  dispatch: React.Dispatch<CashierAction>
  promotions: Promotion[]
  discountCodes: DiscountCode[]
  subtotal: number
  outletId: string
  timezone?: string | null
  isValidatingCode: boolean
  onSelectPromotion: (promo: Promotion) => void
  onApplyPromoCode: () => void
  onApplyDiscount: () => void
  onApplySurcharge: () => void
  promoCodeError: string | null
  onClearPromoCodeError: () => void
}

export const AdjustmentDrawer = memo(function AdjustmentDrawer({
  state,
  dispatch,
  promotions,
  discountCodes,
  subtotal,
  outletId,
  timezone,
  isValidatingCode,
  onSelectPromotion,
  onApplyPromoCode,
  onApplyDiscount,
  onApplySurcharge,
  promoCodeError,
  onClearPromoCodeError,
}: AdjustmentDrawerProps) {
  if (!state.activeAdjustment) return null

  const close = () => dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel: null })

  if (state.activeAdjustment === 'notes') {
    return (
      <Sheet open variant="center" z={40} maxWidth="max-w-sm" panelClassName="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-gray-900">Catatan Order</h3>
            <button type="button" onClick={close} className="text-gray-400 hover:text-gray-600">×</button>
          </div>
          <textarea
            value={state.orderNotes}
            onChange={(e) => dispatch({ type: 'SET_ORDER_NOTES', notes: e.target.value })}
            rows={3}
            placeholder="Catatan untuk order ini…"
            aria-label="Catatan order"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none mb-3"
          />
          <button type="button"
            onClick={close}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-semibold text-sm"
          >
            Simpan
          </button>
      </Sheet>
    )
  }

  if (state.activeAdjustment === 'discount') {
    return (
      <Sheet open variant="center" z={40} maxWidth="max-w-sm" panelClassName="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-gray-900">Diskon / Surcharge</h3>
            <button type="button" onClick={close} className="text-gray-400 hover:text-gray-600">×</button>
          </div>
          <div className="flex gap-2 mb-3">
            {(['percentage', 'fixed'] as const).map((t) => (
              <button type="button"
                key={t}
                onClick={() => dispatch({ type: 'SET_DISCOUNT_TYPE', discountType: t })}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border ${
                  state.discountType === t
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-200 text-gray-600'
                }`}
              >
                {t === 'percentage' ? 'Persen (%)' : 'Nominal (Rp)'}
              </button>
            ))}
          </div>
          <input
            type="number"
            inputMode="numeric"
            value={state.adjustInputStr}
            onChange={(e) => dispatch({ type: 'SET_ADJUST_INPUT', value: e.target.value })}
            placeholder={state.discountType === 'percentage' ? 'Contoh: 10' : 'Contoh: 5000'}
            aria-label="Nilai diskon atau surcharge"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 mb-3"
          />
          <div className="flex gap-2">
            <button type="button"
              onClick={onApplyDiscount}
              className="flex-1 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold"
            >
              Diskon −
            </button>
            <button type="button"
              onClick={onApplySurcharge}
              className="flex-1 py-2 bg-orange-500 text-white rounded-xl text-sm font-semibold"
            >
              Surcharge +
            </button>
          </div>
          {(state.discountRunning > 0 || state.surchargeRunning > 0) && (
            <button type="button"
              onClick={() => dispatch({ type: 'CLEAR_DISCOUNT' })}
              className="w-full mt-2 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg"
            >
              Hapus semua
            </button>
          )}
      </Sheet>
    )
  }

  return (
    <PromoPanel
      promotions={promotions}
      discountCodes={discountCodes}
      appliedPromotions={state.appliedPromotions}
      appliedPromoCodes={state.appliedPromoCodes}
      cart={state.cart}
      bundleFreed={state.bundleFreed}
      selectionCart={(promo) => promotionPreviewCart(state, promo)}
      promoCodeInput={state.promoCodeInput}
      isValidating={isValidatingCode}
      subtotal={subtotal}
      outletId={outletId}
      timezone={timezone}
      hasCustomer={state.selectedCustomer !== null}
      onSelectPromotion={onSelectPromotion}
      onRemovePromotion={(id) => dispatch({ type: 'REMOVE_PROMOTION', id })}
      onClearPromotion={() => dispatch({ type: 'CLEAR_PROMOTIONS' })}
      onPromoCodeChange={(v) => dispatch({ type: 'SET_PROMO_CODE_INPUT', value: v })}
      onApplyPromoCode={onApplyPromoCode}
      onRemovePromoCode={(code) => dispatch({ type: 'REMOVE_PROMO_CODE', code })}
      onClose={close}
      promoCodeError={promoCodeError}
      onClearPromoCodeError={onClearPromoCodeError}
    />
  )
})
