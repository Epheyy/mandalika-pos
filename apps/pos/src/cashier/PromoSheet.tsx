import type { ReactNode } from 'react'
import { Sheet } from '../components/ui/Sheet'
import { formatRupiah } from './pricing'

interface PromoSheetProps {
  onClose: () => void
  /** A BXGY reward or bundle slot picker. It REPLACES the list inside this same sheet (never stacks on it). */
  picker?: ReactNode
  /** W7-11: the cart subtotal, shown beside the title in the list view (display only). */
  subtotal?: number
  children: ReactNode
}

/** B2: the one "Promo & Diskon" door. Side sheet; the list view holds the code field,
 *  applied items, available promos and the manual discount section; a picker swaps in
 *  for the list and brings its own "‹ Kembali" header. */
export function PromoSheet({ onClose, picker, subtotal, children }: PromoSheetProps) {
  return (
    <Sheet
      open
      onClose={onClose}
      variant="side"
      z={40}
      maxWidth="max-w-md"
      closeLabel="Tutup"
      panelClassName="flex flex-col"
      header={!picker}
      title={picker ? undefined : (
        <>
          Promo &amp; Diskon
          {subtotal !== undefined && <span className="tnum ml-3 text-[0.8125rem] font-bold text-ink-700">Subtotal {formatRupiah(subtotal)}</span>}
        </>
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        {picker ? (
          picker
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        )}
      </div>
    </Sheet>
  )
}
