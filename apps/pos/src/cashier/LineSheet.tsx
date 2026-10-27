import type { components } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { formatRupiah } from './pricing'
import type { SizeOption } from './lineSizes'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { Sheet } from '../components/ui/Sheet'
import { Stepper } from '../components/ui/Stepper'
import { IconClose } from '../components/ui/icons'

type CartItem = components['schemas']['CartItem']

interface LineSheetProps {
  /** The paid cart line being edited; null keeps the sheet closed. */
  line: CartItem | null
  /** The product's sizes (fewer than two hides the size switch). */
  sizes: SizeOption[]
  hasOrderNotes: boolean
  /** Same contract as the cart stepper: 0 removes the line. */
  onSetQty: (qty: number) => void
  onRemove: () => void
  onSwitchSize: (toSize: string) => void
  onOpenNotes: () => void
  onClose: () => void
}

/** B1 line sheet: tapping a cart line opens this centre sheet with a 48 dp quantity
 *  stepper, the product's other sizes as chips, the order-level Catatan shortcut and
 *  a 48 dp Hapus. Per-line notes are not in the order payload, so Catatan stays order-level. */
export function LineSheet({ line, sizes, hasOrderNotes, onSetQty, onRemove, onSwitchSize, onOpenNotes, onClose }: LineSheetProps) {
  const sizeText = line ? variantLabel(line.variantSize) : ''
  return (
    <Sheet
      open={line !== null}
      onClose={onClose}
      variant="center"
      z={50}
      closeLabel="Tutup detail baris"
      panelClassName="overflow-hidden"
      title={<span className="block px-5 pt-5 pb-1 pr-16 text-lg text-ink-900">{line?.productName}</span>}
    >
      {line && (
        <div className="px-5 pb-5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="touch absolute right-3 top-3 inline-flex items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
          >
            <IconClose size={22} />
          </button>
          <p className="tnum text-[0.9375rem] text-ink-700">
            {sizeText && <span className="font-semibold text-ink-900">{sizeText} · </span>}
            {formatRupiah(line.price)} / unit
          </p>

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-[0.9375rem] font-semibold text-ink-900">Jumlah</span>
            <Stepper
              value={line.quantity}
              onDecrement={() => onSetQty(line.quantity - 1)}
              onIncrement={() => onSetQty(line.quantity + 1)}
            />
            <span className="tnum min-w-24 text-right text-base font-bold text-ink-900">{formatRupiah(line.subtotal)}</span>
          </div>

          {sizes.length > 1 && (
            <div className="mt-4">
              <p className="mb-2 text-[0.8125rem] font-semibold text-ink-500">Ukuran</p>
              <div className="flex flex-wrap gap-2">
                {sizes.map((s) => (
                  <Chip
                    key={s.size}
                    selected={s.current}
                    onClick={s.current ? undefined : () => onSwitchSize(s.size)}
                  >
                    {variantLabel(s.size) || s.size} · {formatRupiah(s.price)}
                    {s.stock <= 0 && <span className="text-danger"> · Habis</span>}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <Button variant="secondary" active={hasOrderNotes} onClick={onOpenNotes} className="flex-1">
              Catatan
            </Button>
            <Button variant="danger" onClick={onRemove} className="flex-1">
              Hapus
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
