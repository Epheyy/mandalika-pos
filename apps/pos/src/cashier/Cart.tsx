import { memo } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'
import { variantLabel } from '@mandalika/types'
import type { AppliedPromoCode } from './promoValidate'
import { IconClock, IconClose } from '../components/ui/icons'
import { Button } from '../components/ui/Button'
import { Stepper } from '../components/ui/Stepper'

type CartItem = components['schemas']['CartItem']
type AppSettings = components['schemas']['AppSettings']
type Customer = components['schemas']['Customer']
type Promotion = components['schemas']['Promotion']

interface CartProps {
  cart: CartItem[]
  derived: CartDerived
  settings: AppSettings
  selectedCustomer: Customer | null
  pendingSync: boolean
  onRemove: (productId: string, variantSize: string) => void
  onSetQty: (productId: string, variantSize: string, qty: number) => void
  onClear: () => void
  onCheckout: () => void
  onOpenAdjustment: (panel: 'notes' | 'discount' | 'promo') => void
  discountRunning: number
  discountType: 'percentage' | 'fixed'
  surchargeRunning: number
  orderNotes: string
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  onClearDiscount: () => void
  onRemovePromotion: (id: string) => void
  onRemovePromoCode: (code: string) => void
  loyaltyEnabled: boolean
  wallRaised: boolean
}

/** Small coloured tag in front of a promo or reward line. */
function Tag({ tone, children }: { tone: 'promo' | 'reward'; children: string }) {
  const palette = tone === 'promo' ? 'bg-promo-bg text-promo' : 'bg-reward-bg text-reward'
  return <span className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-xs font-bold ${palette}`}>{children}</span>
}

/** 48 dp remove control for a totals row; negative margin keeps the row compact. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="touch -my-3 inline-flex items-center justify-center rounded-control text-promo active:bg-promo-bg"
    >
      <IconClose size={16} />
    </button>
  )
}

export const Cart = memo(function Cart({
  cart,
  derived,
  settings,
  selectedCustomer,
  pendingSync,
  onRemove,
  onSetQty,
  onClear,
  onCheckout,
  onOpenAdjustment,
  discountRunning,
  discountType,
  surchargeRunning,
  orderNotes,
  appliedPromotions,
  appliedPromoCodes,
  onClearDiscount,
  onRemovePromotion,
  onRemovePromoCode,
  loyaltyEnabled,
  wallRaised,
}: CartProps) {
  const isEmpty = cart.length === 0
  const rewardLines = cart.filter((i) => i.isReward).length
  const hasPromo = appliedPromotions.length > 0 || appliedPromoCodes.length > 0
  const hasManual = discountRunning > 0 || surchargeRunning > 0

  return (
    <div className="flex h-full flex-col border-l border-paper-2 bg-white">
      {/* Active customer — pinned at the very top of the cart */}
      {selectedCustomer && (
        <div className="flex min-h-14 flex-shrink-0 items-center gap-3 bg-paper-1 px-4 py-2">
          <span aria-hidden="true" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-paper-2 text-base font-bold text-ink-700">
            {(selectedCustomer.name || '?').charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.9375rem] font-semibold text-ink-900">{selectedCustomer.name}</p>
            <p className="truncate text-[0.8125rem] text-ink-500">
              {selectedCustomer.phone}
              {loyaltyEnabled && ` · ${selectedCustomer.points} poin`}
              {rewardLines > 0 && <span className="font-semibold text-reward">{` · ${rewardLines} hadiah`}</span>}
            </p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-paper-2 px-4 py-3">
        <h2 className="text-base font-bold text-ink-900">
          Keranjang
          {derived.totalCartItems > 0 && (
            <span className="tnum ml-2 rounded-full bg-ink-900 px-2 py-0.5 text-xs text-white">
              {derived.totalCartItems}
            </span>
          )}
        </h2>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto px-4">
        {isEmpty ? (
          <div className="flex h-32 flex-col items-center justify-center text-ink-500">
            <p className="text-[0.9375rem]">Keranjang kosong</p>
            <p className="mt-1 text-[0.8125rem]">Pilih produk untuk mulai</p>
          </div>
        ) : (
          cart.map((item) => (
            <div
              key={`${item.productId}-${item.variantSize}-${item.isReward ? item.rewardPromotionId ?? item.rewardConditionId ?? 'r' : ''}`}
              className="flex min-h-16 items-center gap-3 border-b border-paper-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink-900">
                  <span className="truncate">{item.productName}</span>
                  {item.isReward && <Tag tone="reward">HADIAH</Tag>}
                </p>
                {variantLabel(item.variantSize) && <p className="text-[0.8125rem] text-ink-500">{variantLabel(item.variantSize)}</p>}
                {item.isReward && (
                  <p className="text-[0.8125rem] text-ink-500">{item.rewardPromotionId ? 'Hadiah Promo' : 'Hadiah Loyalti'}</p>
                )}
              </div>
              {item.isReward ? (
                <>
                  <span className="tnum flex h-9 min-w-9 items-center justify-center rounded-lg bg-paper-1 px-2 text-base font-semibold text-ink-900">
                    {item.quantity}
                  </span>
                  <p className={`tnum min-w-20 text-right text-base font-bold ${item.subtotal <= 0 ? 'text-reward' : 'text-ink-900'}`}>
                    {item.subtotal <= 0 ? 'GRATIS' : formatRupiah(item.subtotal)}
                  </p>
                </>
              ) : (
                <>
                  <Stepper
                    value={item.quantity}
                    onDecrement={() => onSetQty(item.productId, item.variantSize, item.quantity - 1)}
                    onIncrement={() => onSetQty(item.productId, item.variantSize, item.quantity + 1)}
                  />
                  <div className="min-w-20 text-right">
                    <p className="tnum text-base font-bold text-ink-900">{formatRupiah(item.subtotal)}</p>
                    <p className="tnum text-xs text-ink-500">{formatRupiah(item.price)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(item.productId, item.variantSize)}
                    aria-label="Hapus"
                    className="touch -mr-2 inline-flex items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
                  >
                    <IconClose size={20} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Adjustments row */}
      {!isEmpty && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-paper-2 px-4 py-2">
          <Button variant="promo" onClick={() => onOpenAdjustment('promo')} className={hasPromo ? 'ring-2 ring-promo' : ''}>
            Promo &amp; Kode
          </Button>
          <Button variant="secondary" onClick={() => onOpenAdjustment('notes')} className={orderNotes ? 'border-ink-700' : ''}>
            Catatan
          </Button>
          <Button variant="secondary" onClick={() => onOpenAdjustment('discount')} className={hasManual ? 'border-warn text-warn' : ''}>
            Diskon manual
          </Button>
          <Button variant="ghost" onClick={onClear} className="ml-auto">
            Kosongkan
          </Button>
        </div>
      )}

      {/* Totals */}
      {!isEmpty && (
        <div className="flex-shrink-0 space-y-2 border-t border-paper-2 px-4 py-3 text-[0.9375rem]">
          <div className="tnum flex justify-between text-ink-700">
            <span>Subtotal</span>
            <span>{formatRupiah(derived.subtotal)}</span>
          </div>
          {appliedPromotions.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">PROMO</Tag>
                <span className="truncate">{p.name}</span>
              </span>
              <RemoveButton label="Hapus promo" onClick={() => onRemovePromotion(p.id)} />
            </div>
          ))}
          {appliedPromoCodes.map((c) => (
            <div key={c.code} className="flex items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">PROMO</Tag>
                <span className="truncate">Kode Promo: {c.code}</span>
              </span>
              <RemoveButton label="Hapus kode" onClick={() => onRemovePromoCode(c.code)} />
            </div>
          ))}
          {hasPromo && derived.promoDiscountAmount > 0 && (
            <div className="tnum flex justify-between text-promo">
              <span>Hemat promo</span>
              <span>−{formatRupiah(derived.promoDiscountAmount)}</span>
            </div>
          )}
          {discountRunning > 0 && (
            <div className="flex items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">PROMO</Tag>
                <span className="truncate">
                  Diskon manual{' '}
                  {discountType === 'percentage' ? `${discountRunning}%` : formatRupiah(discountRunning)}
                </span>
              </span>
              <RemoveButton label="Hapus diskon" onClick={onClearDiscount} />
            </div>
          )}
          {derived.discountAmount > 0 && (
            <div className="tnum flex justify-between font-semibold text-promo">
              <span>Total hemat</span>
              <span>−{formatRupiah(derived.discountAmount)}</span>
            </div>
          )}
          {derived.surchargeAmount > 0 && (
            <div className="tnum flex justify-between text-warn">
              <span>Biaya tambahan</span>
              <span>+{formatRupiah(derived.surchargeAmount)}</span>
            </div>
          )}
          {settings.taxEnabled && derived.taxAmount > 0 && (
            <div className="tnum flex justify-between text-ink-700">
              <span>PPN {settings.taxRate}%</span>
              <span>{formatRupiah(derived.taxAmount)}</span>
            </div>
          )}
          <div className="tnum flex justify-between border-t border-paper-2 pt-2 font-bold text-ink-900">
            <span>Total</span>
            <span>{formatRupiah(derived.total)}</span>
          </div>
          {pendingSync && (
            <p className="mt-1 text-center text-[0.8125rem] text-warn">
              <IconClock size={14} className="inline-block align-[-0.125em]" /> Tersimpan di tablet
            </p>
          )}
        </div>
      )}

      {/* Bayar bar: 64 dp, brand fill. The aria-label keeps the button's name "Bayar" (the total is in the visible text). */}
      <div className="flex-shrink-0 safe-bottom">
        {isEmpty ? (
          <button type="button" disabled className="flex min-h-16 w-full items-center justify-center bg-paper-1 text-base font-semibold text-ink-500">
            Pilih produk
          </button>
        ) : (
          <button
            type="button"
            onClick={onCheckout}
            disabled={wallRaised}
            aria-label={wallRaised ? undefined : 'Bayar'}
            className="tnum flex min-h-16 w-full items-center justify-between bg-brand px-5 text-on-brand active:bg-brand-pressed disabled:opacity-40"
          >
            {wallRaised ? (
              <span className="mx-auto text-lg font-bold">Sinkronisasi diperlukan</span>
            ) : (
              <>
                <span className="text-lg font-bold uppercase">Bayar</span>
                <span className="text-2xl font-bold">{formatRupiah(derived.total)}</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
})
