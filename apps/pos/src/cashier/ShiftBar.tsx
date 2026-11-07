import { memo, useEffect, useRef, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'
import { Sheet } from '../components/ui/Sheet'
import { Button } from '../components/ui/Button'
import { IconLock } from '../components/ui/icons'

type Shift = components['schemas']['Shift']

interface ShiftBarProps {
  currentShift: Shift | null
  isLoading: boolean
  isOpening: boolean
  /** Resolves true once the shift is durably queued (false = not saved, keep the modal). */
  onOpenShift: (startingCash: number) => Promise<boolean>
  /** Real server reachability, for the hint next to the disabled button. */
  isOnline: boolean
  /** Server reachable AND a shift answer received this session. Opening a shift needs both
   *  (A04); an already-open shift keeps selling offline. */
  canOpen: boolean
  /** Persistent error when the open could not be stored on the device. */
  error?: string | null
  /** Closing is reconciled in the Rekap screen (counted income is mandatory),
   *  so "Tutup Shift" in the shift pill's menu routes there instead of a quick-close modal. */
  onRequestClose: () => void
  /** When toggled true, force-opens the open-shift modal (e.g. a sale was
   *  attempted with no active shift). */
  promptOpen?: boolean
  onPromptConsumed?: () => void
}

/** "09:12" in the tablet's local clock (the mock's pill copy; id-ID locale would print "09.12"). */
function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const ShiftBar = memo(function ShiftBar({
  currentShift,
  isLoading,
  isOpening,
  onOpenShift,
  isOnline,
  canOpen,
  error,
  onRequestClose,
  promptOpen,
  onPromptConsumed,
}: ShiftBarProps) {
  const [showOpenModal, setShowOpenModal] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  // The popover is rendered fixed and anchored to the button's on-screen rect (an absolute
  // popover would be clipped — that was the "dropdown shows nothing" bug).
  const detailBtnRef = useRef<HTMLButtonElement>(null)
  const [detailPos, setDetailPos] = useState<{ top: number; left: number } | null>(null)
  const [depositStr, setDepositStr] = useState('')

  const toggleDetail = () => {
    setShowDetail((v) => {
      const next = !v
      if (next) {
        const r = detailBtnRef.current?.getBoundingClientRect()
        if (r) setDetailPos({ top: r.bottom + 8, left: r.left })
      }
      return next
    })
  }

  useEffect(() => {
    if (promptOpen && !currentShift) {
      // Offline the modal could only fail; the header already says why.
      if (canOpen) setShowOpenModal(true)
      onPromptConsumed?.()
    }
  }, [promptOpen, currentShift, canOpen, onPromptConsumed])

  if (isLoading) {
    return <span className="text-xs text-ink-500">Memuat shift…</span>
  }

  const handleOpen = async () => {
    const cash = parseFloat(depositStr) || 0
    // Keep the modal (and the typed amount) open unless the shift was saved.
    if (!(await onOpenShift(cash))) return
    setShowOpenModal(false)
    setDepositStr('')
  }

  return (
    <>
      {/* Compact inline chip — lives in the app header bar, right of the search field.
          Tap the chip to reveal Mulai / Kas-awal detail in a popover (works in
          portrait where the inline detail wouldn't fit). */}
      {currentShift ? (
        <div className="relative flex items-center gap-1.5 min-w-0">
          <button type="button"
            ref={detailBtnRef}
            onClick={toggleDetail}
            className="press flex min-h-11 min-w-0 flex-shrink items-center gap-2 rounded-chip bg-ok-bg px-3 text-ok"
            aria-expanded={showDetail}
            title="Detail shift"
          >
            <span className="w-2 h-2 rounded-full bg-ok flex-shrink-0" />
            <span className="tnum whitespace-nowrap min-w-0 truncate text-sm font-bold">Shift<span className="sr-only min-[1100px]:not-sr-only"> aktif</span> · {formatClock(currentShift.openedAt)}</span>
            <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${showDetail ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {showDetail && (
            <>
              {/* click-away */}
              <button type="button" aria-label="Tutup" tabIndex={-1} className="fixed inset-0 z-40" onClick={() => setShowDetail(false)} />
              <div
                style={detailPos ? { position: 'fixed', top: detailPos.top, left: detailPos.left } : undefined}
                className="surface-solid z-50 w-56 space-y-2 rounded-sheet p-3"
              >
                <p className="text-xs font-bold text-ink-900">Shift Aktif</p>
                <div className="flex justify-between text-xs">
                  <span className="text-ink-500">Mulai</span>
                  <span className="font-bold text-ink-900">
                    {new Date(currentShift.openedAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-ink-500">Kas Awal</span>
                  <span className="font-bold text-ink-900">{formatRupiah(currentShift.startingCash)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-ink-500">Kasir</span>
                  <span className="font-bold text-ink-900 truncate ml-2">{currentShift.cashierName}</span>
                </div>
                <p className="text-xs text-ink-500 pt-1 border-t border-paper-2">
                  Penjualan & rekonsiliasi ada di menu Rekap Shift.
                </p>
                {/* D-98 / W1-02: Tutup Shift lives in this menu so the header bar fits at 1006 px. It still opens the Rekap
                    count + the selisih confirm; only the entry point moved. */}
                <button type="button"
                  onClick={() => { setShowDetail(false); onRequestClose() }}
                  className="surface-card press mt-1 min-h-11 w-full rounded-chip px-4 text-sm font-semibold text-ink-900 active:bg-paper-1"
                >
                  Tutup Shift
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-paper-2 flex-shrink-0" />
          <button type="button"
            onClick={() => setShowOpenModal(true)}
            disabled={!canOpen}
            title={canOpen ? undefined : 'Buka Shift butuh koneksi internet dan data shift dari kantor pusat'}
            className="press inline-flex min-h-11 items-center gap-1 rounded-chip bg-brand-strong px-4 py-1 text-sm font-semibold text-on-brand active:bg-brand-strong-hover disabled:bg-paper-2 disabled:text-ink-500 disabled:cursor-not-allowed"
          >
            {!canOpen && !isOnline && <IconLock size={14} />}
            Buka Shift
          </button>
          {!canOpen && (
            <span role="status" className="text-xs font-semibold text-warn-strong whitespace-nowrap">
              {isOnline ? 'Memeriksa shift…' : 'Butuh internet'}
            </span>
          )}
        </div>
      )}

      {/* Open shift modal */}
      {showOpenModal && (
        <Sheet open variant="center" maxWidth="max-w-xs" panelClassName="p-5">
            <h3 className="mb-4 text-lg font-bold text-ink-900">Buka Shift Baru</h3>
            <label htmlFor="shift-starting-cash" className="mb-1 block text-sm font-semibold text-ink-700">
              Kas Awal
            </label>
            <input
              id="shift-starting-cash"
              type="number"
              inputMode="numeric"
              value={depositStr}
              onChange={(e) => setDepositStr(e.target.value)}
              placeholder="0"
              className="tnum mb-4 min-h-12 w-full rounded-control border border-paper-2 bg-paper-0 px-3 text-base font-bold focus:border-ink-700 focus:outline-none"
            />
            {error && (
              <p role="alert" className="mb-3 rounded-control border border-danger/30 bg-danger-bg px-3 py-2 text-xs font-semibold text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setShowOpenModal(false)} className="flex-1">
                Batal
              </Button>
              <Button onClick={() => void handleOpen()} disabled={isOpening} className="flex-1">
                {isOpening ? 'Membuka…' : 'Buka'}
              </Button>
            </div>
        </Sheet>
      )}
    </>
  )
})
