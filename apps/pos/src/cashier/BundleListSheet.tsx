import type { components } from '@mandalika/api'
import { Sheet } from '../components/ui/Sheet'
import { formatRupiah } from './pricing'
import { offerSoldOut, type BundleOffer } from './setBundles'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

interface BundleListSheetProps {
  /** The product whose bundles are listed; null keeps the sheet closed. */
  product: Product | null
  offers: BundleOffer[]
  products: Product[]
  cart: CartItem[]
  onPick: (product: Product, offer: BundleOffer) => void
  onClose: () => void
}

/** The list a card with 3+ bundles opens (mockup bundle-cards.html): offers grouped by line, sold-out ones greyed. */
export function BundleListSheet({ product, offers, products, cart, onPick, onClose }: BundleListSheetProps) {
  const groups = [...new Set(offers.map((o) => o.lineLabel))]
  return (
    <Sheet open={product !== null} onClose={onClose} variant="center" z={50} panelClassName="overflow-hidden" header title={product ? `${product.name}: pilih bundle` : undefined}>
      {product && (
        <div className="px-3 pb-3 pt-1">
          {groups.map((g) => (
            <div key={g || 'none'}>
              {g && <p className="px-2 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-500">{g}</p>}
              <div className="space-y-1.5">
                {offers.filter((o) => o.lineLabel === g).map((o) => {
                  const out = offerSoldOut(o, product.id, products, cart)
                  return (
                    <button
                      key={`${o.line}|${o.size}`}
                      type="button"
                      disabled={out}
                      onClick={() => onPick(product, o)}
                      aria-label={`${g ? g + ' ' : ''}${o.size} ${out ? 'Habis' : formatRupiah(o.price)}`}
                      className={`press flex min-h-14 w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-left ${
                        out ? 'cursor-not-allowed border border-paper-2 bg-paper-1 text-ink-500' : 'border-2 border-brand-strong bg-paper-0 text-ink-900 active:bg-paper-1'
                      }`}
                    >
                      <span>
                        <span className="text-base font-semibold">{o.size}</span>{' '}
                        {out ? (
                          <span className="rounded-tag bg-paper-2 px-1.5 py-0.5 text-xs font-bold text-ink-700">Habis</span>
                        ) : (
                          <span className="text-[0.8125rem] text-ink-500">+ atomizer 10ml + 2ml</span>
                        )}
                      </span>
                      <span className="tnum text-base font-bold">{formatRupiah(o.price)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}
