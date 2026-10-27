import type { ReactNode } from 'react'
import { Sheet } from '../components/ui/Sheet'
import { IconClose } from '../components/ui/icons'

interface PromoSheetProps {
  onClose: () => void
  /** A BXGY reward or bundle slot picker. It REPLACES the list inside this same sheet (never stacks on it). */
  picker?: ReactNode
  children: ReactNode
}

/** B2: the one "Promo & Diskon" door. Side sheet; the list view holds the code field,
 *  applied items, available promos and the manual discount section; a picker swaps in
 *  for the list and brings its own "‹ Kembali" header. */
export function PromoSheet({ onClose, picker, children }: PromoSheetProps) {
  return (
    <Sheet open onClose={onClose} variant="side" z={40} maxWidth="max-w-md" closeLabel="Tutup" panelClassName="flex flex-col">
      <div className="flex h-full min-h-0 flex-col">
        {picker ? (
          picker
        ) : (
          <>
            <div className="flex flex-shrink-0 items-center justify-between border-b border-paper-2 py-1 pl-5 pr-2">
              <h3 className="text-lg font-bold text-ink-900">Promo &amp; Diskon</h3>
              <button
                type="button"
                onClick={onClose}
                aria-label="Tutup"
                className="touch inline-flex items-center justify-center rounded-control text-ink-500 active:bg-paper-1"
              >
                <IconClose size={22} />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
          </>
        )}
      </div>
    </Sheet>
  )
}
