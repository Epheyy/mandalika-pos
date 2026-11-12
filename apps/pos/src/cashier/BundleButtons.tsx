import type { MouseEvent, PointerEvent, TouchEvent } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { offerButtonMode, offerLabel, offerSoldOut, type BundleOffer } from './setBundles'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const BASE = 'press touch-manipulation rounded-control px-2 py-1.5 text-center leading-tight'
const GOLD = 'bg-brand-strong text-on-brand active:bg-brand-strong-hover'
const OFF = 'cursor-not-allowed bg-paper-2 text-ink-500'

// The card is a drag handle (dnd-kit listens on pointer/mouse/touch down) and a tap target: a bundle button must not
// start a drag nor reach the card's own click.
const shield = {
  onPointerDown: (e: PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  onTouchStart: (e: TouchEvent) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
}

interface BundleButtonsProps {
  productId: string
  offers: BundleOffer[]
  products: Product[]
  cart: CartItem[]
  onTap: (offer: BundleOffer) => void
  onOpenList: () => void
  /** The `Satuan (pilih ukuran)` link: today's size picker. */
  onSingles: () => void
}

/** The gold bundle buttons of a product card (mockup bundle-cards.html, option A): 1-2 offers get a button each,
 *  3+ share one "Bundle · N pilihan" button that opens the list. A bundle whose large bottle is out of stock reads
 *  "Habis" and cannot be tapped (O1). Renders nothing when the product has no offer. */
export function BundleButtons({ productId, offers, products, cart, onTap, onOpenList, onSingles }: BundleButtonsProps) {
  const mode = offerButtonMode(offers)
  if (mode === 'none') return null
  const soldOut = (o: BundleOffer) => offerSoldOut(o, productId, products, cart)
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <div className="space-y-1" data-testid="bundle-buttons" {...shield}>
      {mode === 'buttons' ? (
        <div className="flex gap-1.5">
          {offers.map((o) => {
            const out = soldOut(o)
            return (
              <button
                key={`${o.line}|${o.size}`}
                type="button"
                disabled={out}
                onClick={(e) => { stop(e); onTap(o) }}
                aria-label={`${offerLabel(o)} ${out ? 'Habis' : formatRupiah(o.price)}`}
                className={`${BASE} min-h-12 flex-1 ${out ? OFF : GOLD}`}
              >
                <span className="block text-[0.8125rem] font-semibold">{offerLabel(o)}</span>
                <span className="tnum block text-xs">{out ? 'Habis' : formatRupiah(o.price)}</span>
                {offers.length === 1 && !out && (
                  <span className="block text-[0.6875rem] opacity-90">{o.size} + atomizer 10ml + 2ml</span>
                )}
              </button>
            )
          })}
        </div>
      ) : (
        <ListButton offers={offers} allOut={offers.every(soldOut)} onOpenList={(e) => { stop(e); onOpenList() }} />
      )}
      <button
        type="button"
        onClick={(e) => { stop(e); onSingles() }}
        className="press block min-h-9 w-full text-center text-xs text-ink-500 underline"
      >
        Satuan (pilih ukuran)
      </button>
    </div>
  )
}

function ListButton({ offers, allOut, onOpenList }: { offers: BundleOffer[]; allOut: boolean; onOpenList: (e: MouseEvent) => void }) {
  const from = Math.min(...offers.map((o) => o.price))
  return (
    <button
      type="button"
      disabled={allOut}
      onClick={onOpenList}
      className={`${BASE} block min-h-12 w-full ${allOut ? OFF : GOLD}`}
    >
      <span className="block text-[0.8125rem] font-semibold">{allOut ? 'Bundle · Habis' : `Bundle · ${offers.length} pilihan`}</span>
      {!allOut && <span className="tnum block text-xs">mulai {formatRupiah(from)}</span>}
    </button>
  )
}
