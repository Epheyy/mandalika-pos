import { memo, useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import type { components } from '@mandalika/api'
import type { CartDerived } from '../hooks/useCart'
import { formatRupiah } from './pricing'
import { variantLabel } from '@mandalika/types'
import type { AppliedPromoCode } from './promoValidate'
import { IconChevronRight, IconClock, IconClose } from '../components/ui/icons'
import { Button } from '../components/ui/Button'
import { LineSheet } from './LineSheet'
import { sizeOptions } from './lineSizes'
import { autoPromptLabel } from './promoCopy'
import type { AutoPrompt } from './autoPromos'
import { GIVEAWAY_CAPTION, GIVEAWAY_OUT_OF_STOCK, type GiveawayLine } from './giveaway'

type CartItem = components['schemas']['CartItem']
type AppSettings = components['schemas']['AppSettings']
type Promotion = components['schemas']['Promotion']
type Product = components['schemas']['Product']
type Category = components['schemas']['Category']

/** "50 ml · Extrait": size label, then the product's category (W1-24). Empty when neither is known. */
export function lineSubtitle(item: CartItem, products: Product[], categories: Category[]): string {
  const size = variantLabel(item.variantSize)
  const categoryId = products.find((p) => p.id === item.productId)?.categoryId
  const category = categoryId ? categories.find((c) => c.id === categoryId)?.name : undefined
  return [size, category].filter(Boolean).join(' · ')
}

interface LineKey {
  productId: string
  variantSize: string
}

interface CartProps {
  cart: CartItem[]
  /** C3: the display-only giveaway line (never part of `cart`), or null. */
  giveaway: GiveawayLine | null
  derived: CartDerived
  settings: AppSettings
  /** The customer chip (B3), pinned above the lines. */
  customerSlot: ReactNode
  pendingSync: boolean
  /** Catalog (pending-adjusted) for the line sheet's size switch. */
  products: Product[]
  /** Category names for the line subtitle ("50 ml · Extrait"). */
  categories?: Category[]
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
  /** Promo auto-apply: applied promotions the app installed (shown with an "Otomatis" tag), and the ones waiting for a choice. */
  autoPromotionIds?: string[]
  autoPrompts?: AutoPrompt[]
  onAutoPrompt?: (promotionId: string) => void
  onClearDiscount: () => void
  onRemovePromotion: (id: string) => void
  onRemovePromoCode: (code: string) => void
  wallRaised: boolean
}

/** Small coloured tag in front of a promo or reward line. */
function Tag({ tone, children }: { tone: 'promo' | 'reward' | 'auto'; children: string }) {
  const palette = tone === 'promo' ? 'bg-promo-bg text-promo' : tone === 'auto' ? 'bg-paper-2 text-ink-700' : 'bg-reward-bg text-reward'
  return <span className={`flex-shrink-0 rounded-tag px-1.5 py-0.5 text-xs font-bold ${palette}`}>{children}</span>
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

const ICON_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const
const IconTag = () => <svg {...ICON_PROPS}><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="8.5" r="1.5" /></svg>
const IconNote = () => <svg {...ICON_PROPS}><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>
const IconTrash = () => <svg {...ICON_PROPS}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>

/** Cart action row: three equal icon buttons below the totals (W1 mock). Names stay "Promo & Diskon" / "Catatan" / "Kosongkan". */
const ACTION = 'press flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control px-1 text-sm font-semibold'

export const Cart = memo(function Cart({
  cart,
  giveaway,
  derived,
  settings,
  customerSlot,
  pendingSync,
  products,
  categories = [],
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
  autoPromotionIds = [],
  autoPrompts = [],
  onAutoPrompt,
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
    <div className="m-1.5 ml-0 flex h-[calc(100%-0.75rem)] min-h-0 flex-col overflow-hidden rounded-panel border border-paper-2 sm:m-0 sm:h-full sm:rounded-none sm:border-y-0 sm:border-r-0 bg-[var(--surface-solid-bg)] shadow-[-10px_0_26px_-18px_rgba(70,46,10,0.3)]">
      {/* Header: title with the count under it (a ~280px cart cannot fit title, count, Tersimpan and Simpan on one
          line), Simpan / Tersimpan on the right. The title never shrinks under its text; when title + actions still
          do not fit (wide or scaled fonts) the actions wrap to a second row instead of overlapping the title. */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-1 py-0.5 pl-4 pr-2">
        <div className="flex-shrink-0">
          <h2 className="text-[1.0625rem] font-bold leading-tight text-ink-900">Pesanan</h2>
          {derived.totalCartItems > 0 && (
            <p className="tnum whitespace-nowrap text-[0.8125rem] font-medium leading-tight text-ink-500">
              {derived.totalCartItems} barang
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center">
          {heldCount > 0 && (
            <Button variant="ghost" onClick={onOpenHeld} className="-my-1 min-h-11 px-2">
              Tersimpan ({heldCount})
            </Button>
          )}
          {!isEmpty && (
            /* aria-label differs from the visible text so exact "Simpan" (customer form) stays unambiguous. */
            <Button variant="ghost" onClick={onOpenHeld} aria-label="Simpan keranjang" className="-my-1 min-h-11 px-2">
              Simpan
            </Button>
          )}
        </div>
      </div>
      {/* Customer card (B3), one compact row under the title */}
      {customerSlot}

      {/* Items */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {isEmpty ? (
          <div className="flex h-32 flex-col items-center justify-center text-ink-500">
            <p className="text-[0.9375rem]">Keranjang kosong</p>
            <p className="mt-1 text-[0.8125rem]">Pilih produk untuk mulai</p>
          </div>
        ) : (
          cart.map((item) => (
            <div
              key={`${item.productId}-${item.variantSize}-${item.isReward ? item.rewardPromotionId ?? item.rewardConditionId ?? 'r' : ''}`}
              className="flex min-h-11 items-center gap-2 border-b border-paper-2 py-0.5 last:border-b-0"
            >
              {item.isReward ? (
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink-900">
                    <span className="truncate">{item.productName}</span>
                    <Tag tone="reward">Hadiah</Tag>
                  </p>
                  {lineSubtitle(item, products, categories) && <p className="truncate text-[0.8125rem] text-ink-500">{lineSubtitle(item, products, categories)}</p>}
                  <p className="truncate text-[0.8125rem] text-ink-500">{item.rewardPromotionId ? 'Hadiah Promo' : 'Hadiah Loyalti'}</p>
                </div>
              ) : (
                /* B1: the line body opens the line sheet (qty, size switch, Hapus). */
                <button
                  type="button"
                  onClick={() => setLineKey({ productId: item.productId, variantSize: item.variantSize })}
                  aria-label={`Ubah ${item.productName}${variantLabel(item.variantSize) ? ' ' + variantLabel(item.variantSize) : ''}`}
                  className="min-h-12 min-w-0 flex-1 rounded-control text-left active:bg-paper-1"
                >
                  <span className="line-clamp-2 text-[0.9375rem] font-semibold leading-snug text-ink-900">{item.productName}</span>
                  {lineSubtitle(item, products, categories) && <span className="block truncate text-[0.8125rem] text-ink-500">{lineSubtitle(item, products, categories)}</span>}
                </button>
              )}
              {/* One 36 px quantity pill (W1-23); the quantity is edited in the line sheet (tap the line). */}
              <span className="tnum flex h-9 min-w-9 flex-shrink-0 items-center justify-center rounded-control bg-paper-1 px-2 text-[0.9375rem] font-bold text-ink-900">
                {item.quantity}
              </span>
              {item.isReward ? (
                <p className={`tnum min-w-[4.5rem] flex-shrink-0 text-right text-[0.9375rem] font-bold ${item.subtotal <= 0 ? 'text-reward' : 'text-ink-900'}`}>
                  {item.subtotal <= 0 ? 'Gratis' : formatRupiah(item.subtotal)}
                </p>
              ) : (
                <>
                  <div className="min-w-[4.5rem] flex-shrink-0 text-right">
                    <p className="tnum text-[0.9375rem] font-bold text-ink-900">{formatRupiah(item.subtotal)}</p>
                    {item.quantity > 1 && <p className="tnum text-xs text-ink-500">@ {formatRupiah(item.price)}</p>}
                  </div>
                  {/* Visual "›" affordance for the same sheet; the body button carries the accessible name. */}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    onClick={() => setLineKey({ productId: item.productId, variantSize: item.variantSize })}
                    className="-mx-1 inline-flex min-h-12 w-6 flex-shrink-0 items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
                  >
                    <IconChevronRight size={16} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
        {giveaway && (
          <div data-testid="giveaway-line" className="flex min-h-11 items-center gap-2 border-b border-paper-2 py-0.5 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink-900">
                <span className="truncate">
                  {giveaway.productName}
                  {variantLabel(giveaway.variantSize) ? ` · ${variantLabel(giveaway.variantSize)}` : ''}
                </span>
                <Tag tone="reward">Hadiah</Tag>
              </p>
              <p className="text-[0.8125rem] text-ink-500">{GIVEAWAY_CAPTION}</p>
              {giveaway.outOfStock && <p className="text-[0.8125rem] font-semibold text-warn-strong">{GIVEAWAY_OUT_OF_STOCK}</p>}
            </div>
            <span className="tnum flex h-9 min-w-9 flex-shrink-0 items-center justify-center rounded-control bg-paper-1 px-2 text-[0.9375rem] font-bold text-ink-900">
              {giveaway.quantity}
            </span>
            <p className="tnum min-w-[4.5rem] flex-shrink-0 text-right text-[0.9375rem] font-bold text-reward">Gratis</p>
          </div>
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

      {/* Promo auto-apply: a qualifying promo that needs a choice. One quiet row, never an unprompted picker. */}
      {!isEmpty && autoPrompts.length > 0 && (
        <div className="flex flex-shrink-0 flex-col gap-1 border-t border-paper-2 px-4 py-2">
          {autoPrompts.map((p) => (
            <button
              key={p.promotionId}
              type="button"
              onClick={() => onAutoPrompt?.(p.promotionId)}
              className="touch flex w-full items-center gap-2 rounded-control bg-promo-bg px-3 text-left text-sm font-semibold text-promo active:opacity-80"
            >
              <span className="min-w-0 flex-1 truncate">{autoPromptLabel(p)}</span>
              <IconChevronRight size={16} />
            </button>
          ))}
        </div>
      )}

      {/* Totals: compact; the total itself lives on the Bayar bar only (W1-21) */}
      {!isEmpty && (
        <div className="flex-shrink-0 space-y-0.5 border-t border-paper-2 px-4 py-1 text-[0.9375rem]">
          <div className="tnum flex justify-between text-ink-700">
            <span>Subtotal</span>
            <span>{formatRupiah(derived.subtotal)}</span>
          </div>
          {appliedPromotions.map((p) => (
            <div key={p.id} className="flex min-h-12 items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">Promo</Tag>
                <span className="truncate">{p.name}</span>
                {autoPromotionIds.includes(p.id) && <Tag tone="auto">Otomatis</Tag>}
              </span>
              <RemoveButton label="Hapus promo" onClick={() => onRemovePromotion(p.id)} />
            </div>
          ))}
          {appliedPromoCodes.map((c) => (
            <div key={c.code} className="flex min-h-12 items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">Promo</Tag>
                <span className="truncate">Kode Promo: {c.code}</span>
              </span>
              <RemoveButton label="Hapus kode" onClick={() => onRemovePromoCode(c.code)} />
            </div>
          ))}
          {discountRunning > 0 && (
            <div className="flex min-h-12 items-center justify-between gap-2 text-promo">
              <span className="flex min-w-0 items-center gap-2">
                <Tag tone="promo">Promo</Tag>
                <span className="truncate">
                  Diskon manual{' '}
                  {discountType === 'percentage' ? `${discountRunning}%` : formatRupiah(discountRunning)}
                  {' · '}−{formatRupiah(derived.appliedManualDiscountAmount)}
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
          {pendingSync && (
            <p className="text-center text-[0.8125rem] text-warn-strong">
              <IconClock size={14} className="inline-block align-[-0.125em]" /> Tersimpan di tablet
            </p>
          )}
        </div>
      )}

      {/* Action row: Promo, Catatan, Kosongkan, equal width, below the totals (W1-19) */}
      {!isEmpty && (
        <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-1.5">
          <button
            type="button" onClick={() => onOpenAdjustment('promo')} aria-label={'Promo & Diskon'}
            className={`${ACTION} bg-promo-bg text-promo ${hasPromo || hasManual ? 'ring-2 ring-promo' : ''}`}
          >
            <IconTag /> Promo
          </button>
          <button
            type="button" onClick={() => onOpenAdjustment('notes')}
            className={`${ACTION} ${orderNotes !== '' ? 'border border-ink-700 bg-white text-ink-900' : 'bg-paper-1 text-ink-700'}`}
          >
            <IconNote /> Catatan
          </button>
          <button type="button" onClick={onClear} className={`${ACTION} bg-paper-1 text-ink-700`}>
            <IconTrash /> Kosongkan
          </button>
        </div>
      )}

      {/* Bayar bar: 64 dp, brand fill, inset in the card. The aria-label keeps the button's name "Bayar" (the total is in the visible text). */}
      <div className="flex-shrink-0 safe-bottom">
      <div className="px-3 pb-2">
        {isEmpty ? (
          <button type="button" disabled className="flex min-h-16 w-full items-center justify-center rounded-control bg-paper-1 text-base font-semibold text-ink-500">
            Pilih produk
          </button>
        ) : (
          <button
            type="button"
            onClick={onCheckout}
            disabled={wallRaised}
            aria-label={wallRaised ? undefined : 'Bayar'}
            aria-describedby={wallRaised ? undefined : 'cart-total'}
            className="bar-primary press-bar tnum flex min-h-16 w-full items-center justify-between rounded-control px-5 disabled:opacity-40"
          >
            {wallRaised ? (
              <>
                <span className="text-lg font-bold">Sinkronisasi diperlukan</span>
                <span className="text-xl font-bold">{formatRupiah(derived.total)}</span>
              </>
            ) : (
              <>
                <span className="text-xl font-bold">Bayar</span>
                <span className="text-2xl font-bold">{formatRupiah(derived.total)}</span>
                <span id="cart-total" className="sr-only">Total {formatRupiah(derived.total)}</span>
              </>
            )}
          </button>
        )}
        </div>
      </div>
    </div>
  )
})
