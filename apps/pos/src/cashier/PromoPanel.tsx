import { memo } from 'react'
import type { components } from '@mandalika/api'
import { calcPromoDiscount, formatRupiah, linkedPromoShape } from './pricing'
import { validatePromo, violationMessage, type AppliedPromoCode } from './promoValidate'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']
type CartItem = components['schemas']['CartItem']

interface PromoPanelProps {
  promotions: Promotion[]
  discountCodes: DiscountCode[]
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  cart: CartItem[]
  promoCodeInput: string
  isValidating: boolean
  subtotal: number
  outletId: string
  onSelectPromotion: (promo: Promotion) => void
  onRemovePromotion: (id: string) => void
  onClearPromotion: () => void
  onPromoCodeChange: (value: string) => void
  onApplyPromoCode: () => void
  onRemovePromoCode: (code: string) => void
  onClose: () => void
  promoCodeError: string | null
  onClearPromoCodeError: () => void
}

// CombinableTag surfaces whether a discount stacks with others — the headline
// behavior of the stacking feature. Combinable = indigo pill; exclusive = muted.
function CombinableTag({ combinable }: { combinable: boolean }) {
  return combinable ? (
    <span className="inline-block text-[9px] font-semibold text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5 leading-none">
      Bisa digabung
    </span>
  ) : (
    <span className="inline-block text-[9px] font-semibold text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 leading-none">
      Tidak digabung
    </span>
  )
}

function promoRuleLabel(p: Promotion): string {
  let base: string
  if (p.type === 'percentage') base = `Diskon ${p.value}%`
  else if (p.type === 'fixed') base = `Potongan ${formatRupiah(p.value)}`
  else if (p.type === 'buy_x_get_y') {
    const c = p.bxgyConfig
    if (c) {
      const deal =
        c.getDiscountKind === 'percentage' && c.getDiscountValue === 100
          ? 'Gratis'
          : c.getDiscountKind === 'percentage'
            ? `Diskon ${c.getDiscountValue}%`
            : `Potongan ${formatRupiah(c.getDiscountValue)}`
      base = `Beli ${c.buyQuantity}, ${deal} ${c.getQuantity}`
    } else {
      base = 'Beli X Gratis Y'
    }
  } else base = 'BOGO'
  return p.minPurchase ? `${base} · Min. ${formatRupiah(p.minPurchase)}` : base
}

// Rule label for an applied code chip
const codeRuleLabel = (c: AppliedPromoCode): string => {
    if (c.promotion) {
      return c.promotion.isBOGO
        ? 'BOGO (via promo)'
        : c.promotion.type === 'percentage'
          ? `Diskon ${c.promotion.value}% (via promo)`
          : `Potongan ${formatRupiah(c.promotion.value)} (via promo)`
    }
    return c.type === 'percentage'
      ? `Diskon ${c.value}%`
      : `Potongan ${formatRupiah(c.value)}`
  }

export const PromoPanel = memo(function PromoPanel({
  promotions,
  discountCodes,
  appliedPromotions,
  appliedPromoCodes,
  cart,
  promoCodeInput,
  isValidating,
  subtotal,
  outletId,
  onSelectPromotion,
  onRemovePromotion,
  onClearPromotion,
  onPromoCodeChange,
  onApplyPromoCode,
  onRemovePromoCode,
  onClose,
  promoCodeError,
  onClearPromoCodeError,
}: PromoPanelProps) {
  const now = new Date()
  const evalCtx = { now, outletId, subtotal }
  // code_only promotions are hidden from the browse panel — they are only
  // reachable by typing the linked discount code (SP-Promo-3c).
  const activePromos = promotions.flatMap((promo) =>
    promo.isActive && !promo.codeOnly
      ? [{ promo, violations: validatePromo(promo, evalCtx) }]
      : [],
  )

  const appliedCount = appliedPromotions.length + appliedPromoCodes.length
  const hasApplied = appliedCount > 0

  // Savings shown in the panel use the SAME calc as the cart total: scoped/BOGO
  // promos go through calcPromoDiscount (needs the cart); codes are whole-cart.
  // SP-Promo-3c: linked codes delegate to calcPromoDiscount via the promotion shape.
  const codeSavings = (c: AppliedPromoCode) => {
    if (c.promotion) {
      return calcPromoDiscount(linkedPromoShape(c), cart, subtotal)
    }
    return c.type === 'percentage'
      ? Math.round(subtotal * (c.value / 100))
      : Math.min(c.value, subtotal)
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-sm shadow-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">Promo &amp; Kode Diskon</h3>
          <button type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Applied state — each item with its computed savings */}
          {hasApplied && (
            <div className="rounded-xl border border-green-200 bg-green-50 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-green-200/70">
                <p className="text-[11px] font-bold text-green-800 tracking-wide uppercase">
                  Diterapkan ({appliedCount})
                </p>
                <button type="button"
                  onClick={onClearPromotion}
                  className="text-[11px] text-red-500 hover:text-red-700 font-semibold"
                >
                  Hapus semua
                </button>
              </div>
              <div className="divide-y divide-green-200/60">
                {appliedPromotions.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="text-green-600 text-sm leading-none">✓</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold text-green-900 truncate">
                          {p.name}
                        </p>
                        <CombinableTag combinable={!!p.combinable} />
                      </div>
                      <p className="text-[10px] text-green-700/80">{promoRuleLabel(p)}</p>
                    </div>
                    <p className="text-xs font-bold text-green-800 whitespace-nowrap">
                      −{formatRupiah(calcPromoDiscount(p, cart, subtotal))}
                    </p>
                    <button type="button"
                      onClick={() => onRemovePromotion(p.id)}
                      className="text-red-400 hover:text-red-600 text-base leading-none ml-0.5"
                      aria-label={`Hapus ${p.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {appliedPromoCodes.map((c) => (
                  <div key={c.code} className="flex items-center gap-2 px-3 py-2">
                    <span className="text-green-600 text-sm leading-none">✓</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold text-green-900 truncate">
                          {c.code}
                        </p>
                        <CombinableTag combinable={c.combinable ?? false} />
                      </div>
                      <p className="text-[10px] text-green-700/80">
                        {codeRuleLabel(c)}
                      </p>
                    </div>
                    <p className="text-xs font-bold text-green-800 whitespace-nowrap">
                      −{formatRupiah(codeSavings(c))}
                    </p>
                    <button type="button"
                      onClick={() => onRemovePromoCode(c.code)}
                      className="text-red-400 hover:text-red-600 text-base leading-none ml-0.5"
                      aria-label={`Hapus ${c.code}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Promo code input */}
          <div>
            <p className="text-[11px] font-bold text-gray-500 tracking-wide uppercase mb-2">
              Kode Promo
            </p>
            <div className="flex gap-2">
              <input
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-2.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 uppercase placeholder:normal-case"
                placeholder="Masukkan kode…"
                aria-label="Kode promo"
                value={promoCodeInput}
                onChange={(e) => {
                  onClearPromoCodeError()
                  onPromoCodeChange(e.target.value.toUpperCase())
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onApplyPromoCode()
                }}
              />
              <button type="button"
                onClick={onApplyPromoCode}
                disabled={isValidating || !promoCodeInput.trim()}
                className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors"
              >
                {isValidating ? '…' : 'Pakai'}
              </button>
            </div>
            {promoCodeError && (
              <p className="text-[10px] text-red-500 mt-1.5 font-semibold">
                {promoCodeError}
              </p>
            )}
            {/* Hint: codes matching the typed prefix */}
            {promoCodeInput.length >= 2 && (
              <div className="mt-1.5 space-y-1">
                {discountCodes
                  .filter(
                    (dc) =>
                      dc.isActive &&
                      dc.code.toUpperCase().startsWith(promoCodeInput.toUpperCase()),
                  )
                  .slice(0, 3)
                  .map((dc) => (
                    <button type="button"
                      key={dc.id}
                      onClick={() => onPromoCodeChange(dc.code)}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs bg-gray-50 hover:bg-indigo-50 rounded text-gray-700"
                    >
                      <span className="font-semibold">{dc.code}</span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-gray-500">
                          {dc.type === 'percentage'
                            ? `${dc.value}%`
                            : formatRupiah(dc.value)}
                        </span>
                        <CombinableTag combinable={!!dc.combinable} />
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* Available promotions — multi-toggle */}
          {activePromos.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-gray-500 tracking-wide uppercase mb-2">
                Promosi Aktif
              </p>
              <div className="space-y-2">
                {activePromos.map(({ promo, violations }) => {
                  const gatingInvalid = violations.length > 0
                  const savings = gatingInvalid ? 0 : calcPromoDiscount(promo, cart, subtotal)
                  // buy_x_get_y has a CART precondition (the buy/get items must be
                  // present in the required quantities) that date/min/etc gating
                  // can't see. If the cart doesn't satisfy it, calcPromoDiscount is
                  // 0 — block applying so it can't show as "applied" with no deal.
                  const bxgyUnmet =
                    !gatingInvalid && promo.type === 'buy_x_get_y' && savings <= 0
                  const invalid = gatingInvalid || bxgyUnmet
                  const reason = gatingInvalid
                    ? violationMessage(violations[0])
                    : bxgyUnmet
                      ? 'Syarat beli belum terpenuhi'
                      : null
                  const isApplied = appliedPromotions.some((p) => p.id === promo.id)
                  return (
                    <button type="button"
                      key={promo.id}
                      onClick={() => !invalid && onSelectPromotion(promo)}
                      disabled={invalid}
                      className={`w-full text-left p-3 rounded-xl border transition-all ${
                        invalid
                          ? 'border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed'
                          : isApplied
                            ? 'border-green-400 bg-green-50 ring-1 ring-green-300'
                            : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 active:bg-indigo-100'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-bold text-gray-800">{promo.name}</p>
                        {invalid ? null : isApplied ? (
                          <span className="text-[10px] font-bold text-green-700 whitespace-nowrap">
                            ✓ Diterapkan
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold text-indigo-600 whitespace-nowrap">
                            + Tambah
                          </span>
                        )}
                      </div>
                      {promo.description && (
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {promo.description}
                        </p>
                      )}
                      <p className="text-[10px] text-indigo-600 mt-1">
                        {promoRuleLabel(promo)}
                        {!invalid && savings > 0 && (
                          <span className="text-gray-500">
                            {' · '}hemat {formatRupiah(savings)}
                          </span>
                        )}
                      </p>
                      <div className="mt-1.5">
                        {invalid ? (
                          <span className="text-[10px] text-red-500 font-semibold">
                            {reason}
                          </span>
                        ) : (
                          <CombinableTag combinable={!!promo.combinable} />
                        )}
                      </div>
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
