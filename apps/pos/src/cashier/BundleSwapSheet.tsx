import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Sheet } from '../components/ui/Sheet'
import { formatRupiah } from './pricing'
import { swapTitle, type SwapOption } from './setBundles'

type CartItem = components['schemas']['CartItem']

interface BundleSwapSheetProps {
  /** Null keeps the sheet closed. */
  role: 'atomizer' | 'vial' | null
  /** The bundle's line, for the title and the 2ml's same-line rule (`""` = no line). */
  line: string
  /** The piece being replaced. */
  current: CartItem | null
  /** Pieces in stock after the cart, current piece excluded (`swapCandidates`). */
  options: SwapOption[]
  /** The current piece is at 0 or less: it stays selectable as "Habis · stok akan minus" (O1). */
  currentSoldOut: boolean
  onPick: (option: SwapOption) => void
  /** Keep the current piece (only offered when it is out of stock; the screen then shows the oversell warning). */
  onKeep: () => void
  onClose: () => void
}

/** The swap list (mockup bundle-cart.html): in-stock pieces to swap in, plus the current piece when it is out of stock. */
export function BundleSwapSheet({ role, line, current, options, currentSoldOut, onPick, onKeep, onClose }: BundleSwapSheetProps) {
  return (
    <Sheet open={role !== null} onClose={onClose} variant="center" z={60} panelClassName="overflow-hidden" header title={role ? swapTitle(role, line) : undefined}>
      {role && (
        <div className="px-3 pb-3 pt-2">
          <div className="divide-y divide-paper-2">
            {currentSoldOut && current && (
              <button
                type="button"
                onClick={onKeep}
                className="press flex min-h-14 w-full items-center justify-between gap-3 rounded-control px-2 py-2 text-left active:bg-paper-1"
              >
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-ink-900">{current.productName} {variantLabel(current.variantSize)}</span>
                  <span className="block text-[0.8125rem] font-semibold text-warn-strong">Habis · stok akan minus</span>
                </span>
              </button>
            )}
            {options.map((o) => (
              <button
                key={`${o.productId}|${o.variantSize}`}
                type="button"
                onClick={() => onPick(o)}
                aria-label={`${o.productName} ${variantLabel(o.variantSize)} Stok ${o.stock}`}
                className="press flex min-h-14 w-full items-center justify-between gap-3 rounded-control px-2 py-2 text-left active:bg-paper-1"
              >
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-ink-900">{o.productName}</span>
                  <span className="tnum block text-[0.8125rem] text-ink-500">{variantLabel(o.variantSize)} · {formatRupiah(o.price)}</span>
                </span>
                <span className="tnum flex-shrink-0 text-[0.8125rem] font-semibold text-ok">Stok {Number.isFinite(o.stock) ? o.stock : '–'}</span>
              </button>
            ))}
            {options.length === 0 && !currentSoldOut && (
              <p className="px-2 py-4 text-center text-sm text-ink-500">Tidak ada pengganti yang tersedia.</p>
            )}
          </div>
        </div>
      )}
    </Sheet>
  )
}
