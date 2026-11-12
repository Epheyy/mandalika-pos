import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { IconClose } from '../components/ui/icons'
import { formatRupiah } from './pricing'
import { bundleLabel, pieceOut } from './setBundles'
import { stockFor } from './stock'

type Product = components['schemas']['Product']
type CartItem = components['schemas']['CartItem']

const ROLES = ['large', 'atomizer', 'vial'] as const

interface BundleCartLineProps {
  /** The three pieces of one bundle group. */
  lines: CartItem[]
  /** Stock-adjusted catalog and the whole cart, for each piece's remaining stock. */
  products: Product[]
  cart: CartItem[]
  onSwap: (role: 'atomizer' | 'vial') => void
  onRemove: () => void
}

/** One cart line for a whole bundle (mockup bundle-cart.html, option Y): the title and the bundle price, the three
 *  pieces underneath, and a Ganti button on the atomizer and the 2ml that is always there. */
export function BundleCartLine({ lines, products, cart, onSwap, onRemove }: BundleCartLineProps) {
  const large = lines.find((l) => l.bundleRole === 'large') ?? lines[0]
  const title = `${large.productName} · ${bundleLabel(large.bundleLine ?? '', large.bundleSize ?? '')}`
  const amount = lines.reduce((n, l) => n + l.subtotal, 0)
  const discount = lines.reduce((n, l) => n + (l.bundleDiscount ?? 0), 0)
  return (
    <div data-testid="bundle-line" className="border-b border-paper-2 py-1.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[0.9375rem] font-semibold leading-snug text-ink-900">{title}</p>
        <p className="tnum flex-shrink-0 text-right text-[0.9375rem] font-bold text-ink-900">{formatRupiah(amount)}</p>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Hapus ${title}`}
          className="touch -my-1.5 inline-flex flex-shrink-0 items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
        >
          <IconClose size={16} />
        </button>
      </div>
      {discount > 0 && (
        <p className="tnum text-[0.8125rem] font-semibold text-promo">Diskon Bundle −{formatRupiah(discount)}</p>
      )}
      <div className="mt-1 space-y-1">
        {ROLES.map((role) => {
          const piece = lines.find((l) => l.bundleRole === role)
          if (!piece) return null
          const stock = stockFor(products, piece.productId, piece.variantSize)
          const out = pieceOut(products, cart, piece.productId, piece.variantSize)
          const swapped = role !== 'large' && piece.productId !== large.productId
          const name = `${piece.productName} ${variantLabel(piece.variantSize)}`.trim()
          return (
            <div key={role} className="flex items-center gap-2 border-l-2 border-paper-2 pl-2.5">
              <p className="min-w-0 flex-1 text-[0.8125rem] text-ink-700">
                <span className="line-clamp-2">{name}</span>
                {swapped && <span className="text-ink-500"> (diganti)</span>}
              </p>
              {stock !== null && (
                <span className={`tnum flex-shrink-0 text-xs font-semibold ${out ? 'text-danger' : 'text-ok'}`}>
                  {out ? 'Habis' : `Stok ${stock}`}
                </span>
              )}
              {role !== 'large' && (
                <button
                  type="button"
                  onClick={() => onSwap(role)}
                  aria-label={`Ganti ${role === 'atomizer' ? 'atomizer' : '2ml'} ${title}`}
                  className={`press min-h-9 flex-shrink-0 rounded-control border border-brand-strong px-3 text-xs font-semibold ${
                    out ? 'bg-brand-strong text-on-brand' : 'bg-paper-0 text-brand-strong'
                  }`}
                >
                  Ganti
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
