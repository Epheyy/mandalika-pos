import { useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { useDismiss } from './useDismiss'

/** "Arti angka di menu": what the red and the amber count mean (D-71). */
export function LegendPopover() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useDismiss(open, () => setOpen(false), root)

  return (
    <div ref={root} className="relative px-3 pb-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center justify-center gap-2 rounded-lg px-3 text-xs text-ink-700 hover:bg-paper-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
        Arti angka di menu
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Arti angka di menu"
          className="absolute bottom-full left-3 right-3 z-10 mb-1 surface-solid rounded-xl p-4"
        >
          <h2 className="mb-3 text-sm font-bold text-ink-900">Arti angka di menu</h2>
          <div className="space-y-3 text-xs text-ink-700">
            <p className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger-solid px-1.5 text-[11px] font-bold text-on-brand">
                2
              </span>
              <span>
                <b className="text-ink-900">Merah</b>: perlu keputusan Anda (Persetujuan Stok, Tinjauan Sinkron).
              </span>
            </p>
            <p className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warn-bg px-1.5 text-[11px] font-bold text-warn-strong">
                3
              </span>
              <span>
                <b className="text-ink-900">Kuning</b>: perlu dicek, tidak memblokir (Stok minus belum dicek di Laporan).
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
