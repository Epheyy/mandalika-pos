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
import { Button } from '../components/ui/Button'

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
  /** Live (pending-adjusted) catalog for the stock shown in the BXGY picker. */
  stockProducts: components['schemas']['Product'][]
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
  stockProducts,
  onBxgyConfirm,
  onBundleConfirm,
  onCancelPicker,
  onClosePromo,
}: AdjustmentDrawerProps) {
  if (!state.activeAdjustment) return null

  const close = () => dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel: null })

  if (state.activeAdjustment === 'notes') {
    return (
      <Sheet open variant="center" z={40} maxWidth="max-w-sm" onClose={close} header title="Catatan Order" panelClassName="pb-5">
          <div className="px-5 pt-4">
            <textarea
              value={state.orderNotes}
              onChange={(e) => dispatch({ type: 'SET_ORDER_NOTES', notes: e.target.value })}
              rows={3}
              placeholder="Catatan untuk order ini…"
              aria-label="Catatan order"
              className="mb-3 w-full resize-none rounded-control border border-paper-2 bg-white px-3 py-2 text-sm text-ink-900 focus:border-ink-700 focus:outline-none"
            />
            <Button fullWidth onClick={close}>Simpan</Button>
          </div>
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
        stockProducts={stockProducts}
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
        autoPromotionIds={state.autoPromotionIds}
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
