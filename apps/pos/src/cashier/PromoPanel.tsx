import { memo } from 'react'
import type { components } from '@mandalika/api'
import { calcPromoDiscount, formatRupiah, linkedPromoShape } from './pricing'
import { tieredOneLiner } from './promoCopy'
import type { BundleFreedUnit } from './bundle'
import { validatePromo, violationMessage, type AppliedPromoCode } from './promoValidate'
import { Button } from '../components/ui/Button'
import { unmetCartPrecondition, unmetPreconditionLabel } from './promoEligibility'

type Promotion = components['schemas']['Promotion']
type DiscountCode = components['schemas']['DiscountCode']
type CartItem = components['schemas']['CartItem']

interface PromoPanelProps {
  promotions: Promotion[]
  discountCodes: DiscountCode[]
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  /** Promo auto-apply: ids of applied promotions the app installed (tagged "Otomatis"). */
  autoPromotionIds?: string[]
  cart: CartItem[]
  bundleFreed: Record<string, BundleFreedUnit[]>
  selectionCart?: (promo: Promotion) => CartItem[]
  promoCodeInput: string
  isValidating: boolean
  subtotal: number
  outletId: string
  /** Outlet timezone (A28): promo hours/dates are evaluated on this clock. */
  timezone?: string | null
  hasCustomer: boolean
  onSelectPromotion: (promo: Promotion) => void
  onRemovePromotion: (id: string) => void
  onClearPromotion: () => void
  onPromoCodeChange: (value: string) => void
  onApplyPromoCode: () => void
  onRemovePromoCode: (code: string) => void
  promoCodeError: string | null
  onClearPromoCodeError: () => void
}

// CombinableTag surfaces whether a discount stacks with others — the headline
// behavior of the stacking feature. Combinable = info pill; exclusive = muted.
function CombinableTag({ combinable }: { combinable: boolean }) {
  return combinable ? (
    <span className="inline-block whitespace-nowrap rounded-chip bg-info-bg px-2 py-1 text-xs font-semibold leading-none text-info">
      Bisa digabung
    </span>
  ) : (
    <span className="inline-block whitespace-nowrap rounded-chip bg-paper-1 px-2 py-1 text-xs font-semibold leading-none text-ink-700">
      Tidak bisa digabung
    </span>
  )
}

function promoRuleLabel(p: Promotion): string {
  let base: string
  if (p.type === 'percentage') base = `Diskon ${p.value}%`
  else if (p.type === 'fixed') base = `Hemat ${formatRupiah(p.value)}`
  else if (p.type === 'buy_x_get_y') {
    const c = p.bxgyConfig
    if (c) {
      const deal =
        c.getDiscountKind === 'percentage' && c.getDiscountValue === 100
          ? 'Gratis'
          : c.getDiscountKind === 'percentage'
            ? `Diskon ${c.getDiscountValue}%`
            : `Hemat ${formatRupiah(c.getDiscountValue)}`
      base = `Beli ${c.buyQuantity}, ${deal} ${c.getQuantity}`
    } else {
      base = 'Beli X Gratis Y'
    }
  } else if (p.type === 'tiered') {
    base = 'Beli lebih, hemat lebih'
  } else if (p.type === 'bundle') {
    base = 'Paket Bundel'
  } else base = 'Beli 1 gratis 1'
  return p.minPurchase ? `${base} · Min. ${formatRupiah(p.minPurchase)}` : base
}

// Rule label for an applied code chip
const codeRuleLabel = (c: AppliedPromoCode): string => {
    if (c.promotion) {
      return c.promotion.isBOGO
        ? 'Beli 1 gratis 1 (via promo)'
        : c.promotion.type === 'percentage'
          ? `Diskon ${c.promotion.value}% (via promo)`
          : `Hemat ${formatRupiah(c.promotion.value)} (via promo)`
    }
    return c.type === 'percentage'
      ? `Diskon ${c.value}%`
      : `Hemat ${formatRupiah(c.value)}`
  }

export const PromoPanel = memo(function PromoPanel({
  promotions,
  discountCodes,
  appliedPromotions,
  appliedPromoCodes,
  autoPromotionIds = [],
  cart,
  bundleFreed,
  selectionCart,
  promoCodeInput,
  isValidating,
  subtotal,
  outletId,
  timezone,
  hasCustomer,
  onSelectPromotion,
  onRemovePromotion,
  onClearPromotion,
  onPromoCodeChange,
  onApplyPromoCode,
  onRemovePromoCode,
  promoCodeError,
  onClearPromoCodeError,
}: PromoPanelProps) {
  const now = new Date()
  const evalCtx = { now, outletId, subtotal, hasCustomer, timezone }
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
  // Applied-chip savings. A bundle's saving is realized as zeroed/partial reward
  // lines (calcPromoDiscount returns 0 for it), so derive it from the retained
  // freed set: sum of (fullPrice − net) × quantity. Other promos use the shared calc.
  const appliedSavings = (p: Promotion): number => {
    if (p.type === 'bundle') {
      const freed = bundleFreed[p.id] ?? []
      return freed.reduce((sum, f) => sum + (f.fullPrice - f.net) * f.quantity, 0)
    }
    return calcPromoDiscount(p, cart, subtotal)
  }

  const codeSavings = (c: AppliedPromoCode) => {
    if (c.promotion) {
      return appliedSavings(linkedPromoShape(c))
    }
    return c.type === 'percentage'
      ? Math.round(subtotal * (c.value / 100))
      : Math.min(c.value, subtotal)
  }

  return (
    <div className="space-y-5">
          {/* Promo code input */}
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">
              Kode Promo
            </p>
            <div className="flex gap-2">
              <input
                className="min-h-12 flex-1 rounded-control border border-paper-2 px-3 text-sm uppercase placeholder:normal-case focus:outline-none focus:ring-1 focus:ring-brand-strong"
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
              <Button
                onClick={onApplyPromoCode}
                disabled={isValidating || !promoCodeInput.trim()}
              >
                {isValidating ? '…' : 'Pakai'}
              </Button>
            </div>
            {promoCodeError && (
              <p className="mt-1.5 text-xs font-semibold text-danger">
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
                      className="press flex min-h-11 w-full items-center justify-between gap-2 rounded-control bg-paper-1 px-3 text-sm text-ink-700 active:bg-paper-2"
                    >
                      <span className="font-semibold">{dc.code}</span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-ink-700">
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

          {/* Applied state — each item with its computed savings */}
          {hasApplied && (
            <div className="overflow-hidden rounded-panel bg-ok-bg">
              <div className="flex items-center justify-between border-b border-paper-2 px-3 py-1">
                <p className="text-xs font-bold uppercase tracking-wide text-ok">
                  Diterapkan ({appliedCount})
                </p>
                <button type="button"
                  onClick={onClearPromotion}
                  className="press min-h-11 px-2 text-sm font-semibold text-danger"
                >
                  Hapus semua
                </button>
              </div>
              <div className="divide-y divide-paper-2">
                {appliedPromotions.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-3 py-2.5">
                    <span aria-hidden="true" className="text-sm leading-none text-ok">✓</span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-semibold text-ink-900">
                        {p.name}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <CombinableTag combinable={!!p.combinable} />
                        {autoPromotionIds.includes(p.id) && (
                          <span className="inline-block whitespace-nowrap rounded-chip bg-promo-bg px-2 py-1 text-xs font-semibold leading-none text-promo">
                            Otomatis
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-700">{promoRuleLabel(p)}</p>
                    </div>
                    <p className="tnum whitespace-nowrap text-sm font-bold text-ok">
                      −{formatRupiah(appliedSavings(p))}
                    </p>
                    <button type="button"
                      onClick={() => onRemovePromotion(p.id)}
                      className="press -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-control text-lg leading-none text-ink-700 active:bg-paper-1"
                      aria-label={`Hapus ${p.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {appliedPromoCodes.map((c) => (
                  <div key={c.code} className="flex items-center gap-2 px-3 py-2.5">
                    <span aria-hidden="true" className="text-sm leading-none text-ok">✓</span>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-semibold text-ink-900">
                        {c.code}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <CombinableTag combinable={c.combinable ?? false} />
                      </div>
                      <p className="text-xs text-ink-700">
                        {codeRuleLabel(c)}
                      </p>
                    </div>
                    <p className="tnum whitespace-nowrap text-sm font-bold text-ok">
                      −{formatRupiah(codeSavings(c))}
                    </p>
                    <button type="button"
                      onClick={() => onRemovePromoCode(c.code)}
                      className="press -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-control text-lg leading-none text-ink-700 active:bg-paper-1"
                      aria-label={`Hapus ${c.code}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Available promotions — multi-toggle */}
          {activePromos.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">
                Promo tersedia
              </p>
              <div className="space-y-2">
                {activePromos.map(({ promo, violations }) => {
                  // Preview after takeover/exclusive restoration, as the shared
                  // executor does. A linked bundle must not disable its direct
                  // counterpart merely because its paid units were moved.
                  const candidateCart = selectionCart?.(promo) ?? cart
                  const gatingInvalid = violations.length > 0
                  const savings = gatingInvalid ? 0 : calcPromoDiscount(promo, cart, subtotal)
                  // Cart preconditions that gating can't see (bxgy buy criteria,
                  // bundle sets) live in promoEligibility, shared with auto-apply.
                  const unmet = gatingInvalid ? null : unmetCartPrecondition(promo, candidateCart, savings)
                  const invalid = gatingInvalid || unmet !== null
                  const reason = gatingInvalid
                    ? violationMessage(violations[0])
                    : unmet
                      ? unmetPreconditionLabel(unmet)
                      : null
                  const isApplied = appliedPromotions.some((p) => p.id === promo.id)
                  // A tiered promo gets ONE line (savings now + the next tier) instead of two unrelated fragments.
                  const tierLine = invalid ? null : tieredOneLiner(promo, subtotal, savings)
                  return (
                    <button type="button"
                      key={promo.id}
                      onClick={() => !invalid && onSelectPromotion(promo)}
                      disabled={invalid}
                      className={`press-tile w-full rounded-panel p-3 text-left ${
                        invalid
                          ? 'cursor-not-allowed bg-paper-1 opacity-60'
                          : isApplied
                            ? 'bg-ok-bg ring-2 ring-ok'
                            : 'surface-card active:bg-paper-1'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-bold text-ink-900">{promo.name}</p>
                        {invalid ? null : isApplied ? (
                          <span className="whitespace-nowrap text-xs font-bold text-ok">
                            ✓ Diterapkan
                          </span>
                        ) : (
                          <span className="whitespace-nowrap text-xs font-bold text-brand-strong">
                            + Tambah
                          </span>
                        )}
                      </div>
                      {promo.description && (
                        <p className="mt-0.5 text-xs text-ink-700">
                          {promo.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-promo">
                        {promoRuleLabel(promo)}
                        {!invalid && savings > 0 && !tierLine && (
                          <span className="text-ink-700">
                            {' · '}hemat {formatRupiah(savings)}
                          </span>
                        )}
                      </p>
                      {tierLine && <p className="mt-0.5 text-xs text-ink-700">{tierLine}</p>}
                      <div className="mt-1.5">
                        {invalid ? (
                          <span className="text-xs font-semibold text-danger">
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
            <p className="py-4 text-center text-sm text-ink-500">
              Tidak ada promo aktif
            </p>
          )}
    </div>
  )
})
