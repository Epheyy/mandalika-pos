/**
 * Renders the order-level adjustment surfaces: the Catatan modal and the single
 * "Promo & Diskon" side sheet (B2), which also hosts the BXGY/bundle pickers.
 * Extracted from CashierScreen to keep the orchestrator lean.
 */

import { memo } from 'react'
import type { components } from '@mandalika/api'
import type { CashierState, CashierAction } from './state/cashierReducer'
import { PromoPanel } from './PromoPanel'
import { PromoSheet } from './PromoSheet'
import { ManualDiscountSection } from './ManualDiscountSection'
import { BxgyRewardModal, type BxgyRewardPick } from './BxgyRewardModal'
import { BundleSlotPicker } from './BundleSlotPicker'
import type { BundleAssignment } from './bundle'
import { promotionPreviewCart, type PendingFulfillment } from './promotionFulfillment'
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
  /** A picker waiting for a choice; shown inside the sheet in place of the list. */
  pendingFulfillment: PendingFulfillment | null
  stockFor: (productId: string, variantSize: string) => number | null
  onBxgyConfirm: (picks: BxgyRewardPick[]) => void
  onBundleConfirm: (assignment: BundleAssignment) => void
  /** "‹ Kembali" / Batal in a picker: back to the list, nothing applied. */
  onCancelPicker: () => void
  /** Closes the whole sheet (also drops any pending picker). */
  onClosePromo: () => void
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
  pendingFulfillment,
  stockFor,
  onBxgyConfirm,
  onBundleConfirm,
  onCancelPicker,
  onClosePromo,
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

  const picker =
    pendingFulfillment?.kind === 'bxgy-picker' ? (
      <BxgyRewardModal
        inline
        promo={pendingFulfillment.promo}
        options={pendingFulfillment.options}
        due={pendingFulfillment.due}
        stockProducts={pendingFulfillment.products}
        onConfirm={onBxgyConfirm}
        onCancel={onCancelPicker}
      />
    ) : pendingFulfillment?.kind === 'bundle-picker' ? (
      <BundleSlotPicker
        inline
        cfg={pendingFulfillment.cfg}
        cart={pendingFulfillment.cart}
        promoName={pendingFulfillment.promo.name}
        stockFor={stockFor}
        onConfirm={onBundleConfirm}
        onCancel={onCancelPicker}
      />
    ) : null

  return (
    <PromoSheet onClose={onClosePromo} picker={picker}>
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
        promoCodeError={promoCodeError}
        onClearPromoCodeError={onClearPromoCodeError}
      />
      <ManualDiscountSection
        state={state}
        dispatch={dispatch}
        onApplyDiscount={onApplyDiscount}
        onApplySurcharge={onApplySurcharge}
        initiallyOpen={state.activeAdjustment === 'discount'}
      />
    </PromoSheet>
  )
})
