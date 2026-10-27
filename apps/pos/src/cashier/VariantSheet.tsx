import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { formatRupiah } from './pricing'
import { Sheet } from '../components/ui/Sheet'
import { STOCK_DOT_CLASS, STOCK_TEXT_CLASS, stockLabel, stockTone } from './stockTone'

type Product = components['schemas']['Product']

interface VariantSheetProps {
  /** The multi-size product whose sizes are offered; null keeps the sheet closed. */
  product: Product | null
  /** Tap on a size row: the caller adds one unit and closes the sheet (D-10). */
  onPick: (product: Product, size: string) => void
  onClose: () => void
}

/** B1 variant sheet: one 56 dp row per size with price and stock; a tap adds one unit
 *  (owner decision D-10), no quantity to build first. Out-of-stock sizes stay tappable
 *  (A44: selling past stock warns, never blocks; the screen's add path fires the warning). */
export function VariantSheet({ product, onPick, onClose }: VariantSheetProps) {
  return (
    <Sheet
      open={product !== null}
      onClose={onClose}
      variant="center"
      z={50}
      panelClassName="overflow-hidden"
      title={<span className="block px-5 pt-5 pb-1 text-lg text-ink-900">{product?.name}</span>}
    >
      {product && (
        <div className="px-3 pb-3">
          <p className="px-2 pb-2 text-[0.8125rem] text-ink-500">Ketuk ukuran untuk menambah 1</p>
          <div className="divide-y divide-paper-2">
            {product.variants.map((v) => {
              const label = variantLabel(v.size) || v.size
              const tone = stockTone(v.stock)
              return (
                <button
                  key={v.size}
                  type="button"
                  onClick={() => onPick(product, v.size)}
                  aria-label={`Tambah ${label} · ${formatRupiah(v.price)} · ${stockLabel(v.stock)}`}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-control px-2 py-2 text-left active:bg-paper-1"
                >
                  <span className="min-w-0">
                    <span className="block text-base font-semibold text-ink-900">{label}</span>
                    <span className="tnum block text-[0.9375rem] text-ink-700">{formatRupiah(v.price)}</span>
                  </span>
                  <span className={`tnum flex flex-shrink-0 items-center gap-1.5 text-[0.8125rem] font-semibold ${STOCK_TEXT_CLASS[tone]}`}>
                    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STOCK_DOT_CLASS[tone]}`} />
                    {stockLabel(v.stock)}
                  </span>
                  <span aria-hidden="true" className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control bg-paper-1 text-lg font-semibold text-ink-900">
                    +
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Sheet>
  )
}
