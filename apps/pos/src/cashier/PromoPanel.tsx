import { memo } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { validatePromo, violationMessage } from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']

interface PromoPanelProps {
  promotions: Promotion[]
  discountCodes: DiscountCode[]
  appliedPromotion: Promotion | null
  appliedPromoCode: { code: string; value: number; type: 'percentage' | 'fixed' } | null
  promoCodeInput: string
  isValidating: boolean
  subtotal: number
  outletId: string
  onSelectPromotion: (promo: Promotion) => void
  onClearPromotion: () => void
  onPromoCodeChange: (value: string) => void
  onApplyPromoCode: () => void
  onClose: () => void
  promoCodeError: string | null
  onClearPromoCodeError: () => void
}

export const PromoPanel = memo(function PromoPanel({
  promotions,
  discountCodes,
  appliedPromotion,
  appliedPromoCode,
  promoCodeInput,
  isValidating,
  subtotal,
  outletId,
  onSelectPromotion,
  onClearPromotion,
  onPromoCodeChange,
  onApplyPromoCode,
  onClose,
  promoCodeError,
  onClearPromoCodeError,
}: PromoPanelProps) {
  const now = new Date()
  const evalCtx = { now, outletId, subtotal }
  const activePromos = promotions
    .filter((p) => p.isActive)
    .map((promo) => ({ promo, violations: validatePromo(promo, evalCtx) }))

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Promo & Kode Diskon</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Applied state */}
          {(appliedPromotion || appliedPromoCode) && (
            <div className="flex items-center justify-between p-3 bg-green-50 rounded-xl border border-green-200">
              <div>
                <p className="text-xs font-bold text-green-800">Diterapkan</p>
                <p className="text-xs text-green-700">
                  {appliedPromotion?.name ?? appliedPromoCode?.code}
                </p>
              </div>
              <button
                onClick={onClearPromotion}
                className="text-xs text-red-500 hover:text-red-700 font-semibold"
              >
                Hapus
              </button>
            </div>
          )}

          {/* Promo code input */}
          <div>
            <p className="text-xs font-semibold text-gray-700 mb-2">
              Kode Promo
            </p>
            <div className="flex gap-2">
              <input
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-400 uppercase"
                placeholder="Masukkan kode…"
                value={promoCodeInput}
                onChange={(e) => {
                  onClearPromoCodeError()
                  onPromoCodeChange(e.target.value.toUpperCase())
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onApplyPromoCode()
                }}
              />
              <button
                onClick={onApplyPromoCode}
                disabled={isValidating || !promoCodeInput.trim()}
                className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors"
              >
                {isValidating ? '…' : 'Pakai'}
              </button>
            </div>
            {promoCodeError && (
              <p className="text-[10px] text-red-500 mt-1 font-semibold">
                {promoCodeError}
              </p>
            )}
            {/* Hint: show available codes that match typed prefix */}
            {promoCodeInput.length >= 2 && (
              <div className="mt-1 space-y-1">
                {discountCodes
                  .filter(
                    (dc) =>
                      dc.isActive &&
                      dc.code
                        .toUpperCase()
                        .startsWith(promoCodeInput.toUpperCase()),
                  )
                  .slice(0, 3)
                  .map((dc) => (
                    <button
                      key={dc.id}
                      onClick={() => onPromoCodeChange(dc.code)}
                      className="w-full text-left px-2 py-1 text-xs bg-gray-50 hover:bg-indigo-50 rounded text-gray-700"
                    >
                      {dc.code} —{' '}
                      {dc.type === 'percentage'
                        ? `${dc.value}%`
                        : formatRupiah(dc.value)}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Available promotions */}
          {activePromos.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">
                Promosi Aktif
              </p>
              <div className="space-y-2">
                {activePromos.map(({ promo, violations }) => {
                  const invalid = violations.length > 0
                  const isApplied = appliedPromotion?.id === promo.id
                  return (
                    <button
                      key={promo.id}
                      onClick={() => !invalid && onSelectPromotion(promo)}
                      disabled={invalid}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        invalid
                          ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                          : isApplied
                            ? 'border-green-400 bg-green-50'
                            : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                      }`}
                    >
                      <p className="text-xs font-bold text-gray-800">
                        {promo.name}
                      </p>
                      {promo.description && (
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {promo.description}
                        </p>
                      )}
                      <p className="text-[10px] text-indigo-600 mt-1">
                        {promo.type === 'percentage'
                          ? `Diskon ${promo.value}%`
                          : promo.type === 'fixed'
                            ? `Potongan ${formatRupiah(promo.value)}`
                            : 'BOGO'}
                        {promo.minPurchase
                          ? ` · Min. ${formatRupiah(promo.minPurchase)}`
                          : ''}
                      </p>
                      {invalid && (
                        <p className="text-[10px] text-red-500 mt-1 font-semibold">
                          {violationMessage(violations[0])}
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {activePromos.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-4">
              Tidak ada promosi aktif
            </p>
          )}
        </div>
      </div>
    </div>
  )
})
