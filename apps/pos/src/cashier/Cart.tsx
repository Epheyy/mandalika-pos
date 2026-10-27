import { memo, useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'
import { variantLabel } from '@mandalika/types'
import type { AppliedPromoCode } from './promoValidate'
import { IconChevronRight, IconClock, IconClose } from '../components/ui/icons'
import { Button } from '../components/ui/Button'
import { Stepper } from '../components/ui/Stepper'
import { LineSheet } from './LineSheet'
import { sizeOptions } from './lineSizes'

type CartItem = components['schemas']['CartItem']
type AppSettings = components['schemas']['AppSettings']
type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']

interface LineKey {
  productId: string
  variantSize: string
}

interface CartProps {
  cart: CartItem[]
  derived: CartDerived
  settings: AppSettings
  /** The customer chip (B3), pinned above the lines. */
  customerSlot: ReactNode
  pendingSync: boolean
  /** Catalog (pending-adjusted) for the line sheet's size switch. */
  products: Product[]
  onRemove: (productId: string, variantSize: string) => void
  onSetQty: (productId: string, variantSize: string, qty: number) => void
  /** B1 size switch; returns true when the line was moved (false = blocked, nothing changed). */
  onSwitchSize: (productId: string, fromSize: string, toSize: string) => boolean
  /** Filled while the line sheet is open so Android Back closes it first (returns true when it did). */
  lineBackRef?: MutableRefObject<(() => boolean) | null>
  /** D-6: parked carts on this tablet; the header keeps a chip to them and a Simpan button for this cart. */
  heldCount: number
  onOpenHeld: () => void
  onClear: () => void
  onCheckout: () => void
  onOpenAdjustment: (panel: 'notes' | 'promo') => void
  discountRunning: number
  discountType: 'percentage' | 'fixed'
  surchargeRunning: number
  orderNotes: string
  appliedPromotions: Promotion[]
  appliedPromoCodes: AppliedPromoCode[]
  onClearDiscount: () => void
  onRemovePromotion: (id: string) => void
  onRemovePromoCode: (code: string) => void
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
      className="touch inline-flex items-center justify-center rounded-control text-promo active:bg-promo-bg"
    >
      <IconClose size={16} />
    </button>
  )
}

export const Cart = memo(function Cart({
  cart,
  derived,
  settings,
  customerSlot,
  pendingSync,
  products,
  onRemove,
  onSetQty,
  onSwitchSize,
  lineBackRef,
  heldCount,
  onOpenHeld,
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
  wallRaised,
}: CartProps) {
  const isEmpty = cart.length === 0
  const hasPromo = appliedPromotions.length > 0 || appliedPromoCodes.length > 0
  const hasManual = discountRunning > 0 || surchargeRunning > 0

  // B1 line sheet: keyed by the paid line it edits; derived from the live cart so the
  // quantity and subtotal follow the reducer, and the sheet is simply gone once the line is.
  const [lineKey, setLineKey] = useState<LineKey | null>(null)
  const openLine = lineKey
    ? cart.find((i) => i.productId === lineKey.productId && i.variantSize === lineKey.variantSize && !i.isReward) ?? null
    : null
  // A key whose line is gone is dropped at once (state adjusted during render, no effect),
  // so re-adding that product+size later can never pop the sheet open by itself.
  if (lineKey && !openLine) setLineKey(null)
  const closeLine = () => setLineKey(null)

  // Android Back closes the line sheet before anything underneath.
  useEffect(() => {
    if (!lineBackRef) return
    lineBackRef.current = openLine ? () => { setLineKey(null); return true } : null
    return () => { lineBackRef.current = null }
  }, [openLine, lineBackRef])

  const handleLineQty = (qty: number) => {
    if (!openLine) return
    onSetQty(openLine.productId, openLine.variantSize, qty)
    if (qty <= 0) closeLine()
  }
  const handleLineRemove = () => {
    if (!openLine) return
    onRemove(openLine.productId, openLine.variantSize)
    closeLine()
  }
  const handleLineSwitch = (toSize: string) => {
    if (!openLine) return
    // Follow the line to its new size only when the switch went through.
    if (onSwitchSize(openLine.productId, openLine.variantSize, toSize)) {
      setLineKey({ productId: openLine.productId, variantSize: toSize })
    }
  }
  const handleLineNotes = () => {
    closeLine()
    onOpenAdjustment('notes')
  }

  return (
    <div className="flex h-full flex-col border-l border-paper-2 bg-white">
      {/* Customer chip (B3) — pinned at the very top of the cart */}
      {customerSlot}
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-paper-2 py-1 pl-4 pr-2">
        <h2 className="text-base font-bold text-ink-900">
          Keranjang
          {derived.totalCartItems > 0 && (
            <span className="tnum ml-2 rounded-full bg-ink-900 px-2 py-0.5 text-xs text-white">
              {derived.totalCartItems}
            </span>
          )}
        </h2>
        <div className="flex items-center">
          {heldCount > 0 && (
            <Button variant="ghost" onClick={onOpenHeld} className="min-h-11 px-2">
              Tersimpan ({heldCount})
            </Button>
          )}
          {!isEmpty && (
            <>
              {/* aria-label differs from the visible text so exact "Simpan" (customer form) stays unambiguous. */}
              <Button variant="ghost" onClick={onOpenHeld} aria-label="Simpan keranjang" className="min-h-11 px-2">
                Simpan
              </Button>
              <Button variant="ghost" onClick={onClear} className="min-h-11 px-2">
                Kosongkan
              </Button>
            </>
          )}
        </div>
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
              className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 border-b border-paper-2 py-2 lg:flex-nowrap"
            >
              {item.isReward ? (
                <div className="order-1 min-w-0 flex-1 basis-[calc(100%-4rem)] lg:basis-auto">
                  <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink-900">
                    <span className="truncate">{item.productName}</span>
                    <Tag tone="reward">HADIAH</Tag>
                  </p>
                  {variantLabel(item.variantSize) && <p className="text-[0.8125rem] text-ink-500">{variantLabel(item.variantSize)}</p>}
                  <p className="text-[0.8125rem] text-ink-500">{item.rewardPromotionId ? 'Hadiah Promo' : 'Hadiah Loyalti'}</p>
                </div>
              ) : (
                /* B1: the line body opens the line sheet (qty, size switch, Hapus). */
                <button
                  type="button"
                  onClick={() => setLineKey({ productId: item.productId, variantSize: item.variantSize })}
                  aria-label={`Ubah ${item.productName}${variantLabel(item.variantSize) ? ' ' + variantLabel(item.variantSize) : ''}`}
                  className="order-1 min-h-12 min-w-0 flex-1 basis-[calc(100%-4rem)] rounded-control text-left active:bg-paper-1 lg:basis-auto"
                >
                  <span className="block truncate text-[0.9375rem] font-semibold text-ink-900">{item.productName}</span>
                  {variantLabel(item.variantSize) && <span className="block text-[0.8125rem] text-ink-500">{variantLabel(item.variantSize)}</span>}
                </button>
              )}
              {item.isReward ? (
                <>
                  <span className="tnum order-2 flex h-9 min-w-9 items-center justify-center rounded-lg bg-paper-1 px-2 text-base font-semibold text-ink-900">
                    {item.quantity}
                  </span>
                  <p className={`tnum order-3 ml-auto min-w-20 text-right text-base font-bold ${item.subtotal <= 0 ? 'text-reward' : 'text-ink-900'}`}>
                    {item.subtotal <= 0 ? 'GRATIS' : formatRupiah(item.subtotal)}
                  </p>
                </>
              ) : (
                <>
                  <Stepper
                    className="order-3 lg:order-2"
                    value={item.quantity}
                    onDecrement={() => onSetQty(item.productId, item.variantSize, item.quantity - 1)}
                    onIncrement={() => onSetQty(item.productId, item.variantSize, item.quantity + 1)}
                  />
                  <div className="order-4 ml-auto min-w-20 text-right lg:order-3 lg:ml-0">
                    <p className="tnum text-base font-bold text-ink-900">{formatRupiah(item.subtotal)}</p>
                    <p className="tnum text-xs text-ink-500">{formatRupiah(item.price)}</p>
                  </div>
                  {/* Visual "›" affordance for the same sheet; the body button carries the accessible name. */}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => setLineKey({ productId: item.productId, variantSize: item.variantSize })}
                    className="touch order-2 -mr-2 inline-flex lg:order-4 items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
                  >
                    <IconChevronRight size={20} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <LineSheet
        line={openLine}
        sizes={openLine ? sizeOptions(products.find((p) => p.id === openLine.productId), openLine.variantSize) : []}
        hasOrderNotes={orderNotes !== ''}
        onSetQty={handleLineQty}
        onRemove={handleLineRemove}
        onSwitchSize={handleLineSwitch}
        onOpenNotes={handleLineNotes}
        onClose={closeLine}
      />

      {/* Adjustments row */}
      {!isEmpty && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-paper-2 px-4 py-2">
          <Button variant="promo" active={hasPromo || hasManual} onClick={() => onOpenAdjustment('promo')}>
            Promo &amp; Diskon
          </Button>
          <Button variant="secondary" active={orderNotes !== ''} onClick={() => onOpenAdjustment('notes')}>
            Catatan
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
            <div key={p.id} className="flex min-h-12 items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">PROMO</Tag>
                <span className="truncate">{p.name}</span>
              </span>
              <RemoveButton label="Hapus promo" onClick={() => onRemovePromotion(p.id)} />
            </div>
          ))}
          {appliedPromoCodes.map((c) => (
            <div key={c.code} className="flex min-h-12 items-center justify-between gap-2 text-promo">
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
            <div className="flex min-h-12 items-center justify-between gap-2 text-promo">
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
            <div className="tnum flex justify-between text-ink-700">
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
