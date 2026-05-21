import { memo, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { formatRupiah } from './pricing'

type Shift = components['schemas']['Shift']

interface ShiftBarProps {
  currentShift: Shift | null
  isLoading: boolean
  isOpening: boolean
  isClosing: boolean
  onOpenShift: (startingCash: number) => void
  onCloseShift: (closingCash: number) => void
  /** When toggled true, force-opens the open-shift modal (e.g. a sale was
   *  attempted with no active shift). */
  promptOpen?: boolean
  onPromptConsumed?: () => void
}

export const ShiftBar = memo(function ShiftBar({
  currentShift,
  isLoading,
  isOpening,
  isClosing,
  onOpenShift,
  onCloseShift,
  promptOpen,
  onPromptConsumed,
}: ShiftBarProps) {
  const [showOpenModal, setShowOpenModal] = useState(false)
  const [showCloseModal, setShowCloseModal] = useState(false)
  const [depositStr, setDepositStr] = useState('')
  const [closingStr, setClosingStr] = useState('')

  useEffect(() => {
    if (promptOpen && !currentShift) {
      setShowOpenModal(true)
      onPromptConsumed?.()
    }
  }, [promptOpen, currentShift, onPromptConsumed])

  if (isLoading) {
    return <span className="text-xs text-gray-400">Memuat shift…</span>
  }

  const handleOpen = () => {
    const cash = parseFloat(depositStr) || 0
    onOpenShift(cash)
    setShowOpenModal(false)
    setDepositStr('')
  }

  const handleClose = () => {
    const cash = parseFloat(closingStr) || 0
    onCloseShift(cash)
    setShowCloseModal(false)
    setClosingStr('')
  }

  return (
    <>
      {/* Compact inline chip — lives in the app header beside the brand logo.
          The Mulai/Kas-awal detail moved to the Rekapan panel; the title
          attribute keeps it a tap-away on hover. */}
      {currentShift ? (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-xs font-bold text-gray-800 flex-shrink-0">Shift Aktif</span>
          <span className="text-[10px] text-gray-500 truncate hidden sm:inline">
            · Mulai {new Date(currentShift.openedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            {' · '}Kas {formatRupiah(currentShift.startingCash)}
          </span>
          <button
            onClick={() => setShowCloseModal(true)}
            className="px-2 py-0.5 text-[11px] font-semibold bg-red-50 text-red-600 rounded-md hover:bg-red-100 transition-colors flex-shrink-0"
          >
            Tutup
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-gray-300 flex-shrink-0" />
          <button
            onClick={() => setShowOpenModal(true)}
            className="px-2.5 py-1 text-[11px] font-semibold bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
          >
            Buka Shift
          </button>
        </div>
      )}

      {/* Open shift modal */}
      {showOpenModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-5 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-4">Buka Shift Baru</h3>
            <label className="block text-xs text-gray-600 mb-1">
              Uang awal (kas)
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={depositStr}
              onChange={(e) => setDepositStr(e.target.value)}
              placeholder="0"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-green-400"
            />
            <div className="flex gap-2">
              <button
                onClick={handleOpen}
                disabled={isOpening}
                className="flex-1 py-2 bg-green-600 text-white rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-green-700 transition-colors"
              >
                {isOpening ? 'Membuka…' : 'Buka'}
              </button>
              <button
                onClick={() => setShowOpenModal(false)}
                className="flex-1 py-2 border border-gray-200 rounded-xl font-semibold text-sm text-gray-600"
              >
                Batal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close shift modal */}
      {showCloseModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-xs p-5 shadow-xl">
            <h3 className="font-bold text-gray-900 mb-4">Tutup Shift</h3>
            {currentShift && (
              <div className="bg-gray-50 rounded-xl p-3 mb-4 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Penjualan</span>
                  <span className="font-bold">{formatRupiah(currentShift.totalSales)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Jumlah Order</span>
                  <span className="font-bold">{currentShift.totalOrders}</span>
                </div>
              </div>
            )}
            <label className="block text-xs text-gray-600 mb-1">
              Uang penutup (kas fisik)
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={closingStr}
              onChange={(e) => setClosingStr(e.target.value)}
              placeholder="0"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                onClick={handleClose}
                disabled={isClosing}
                className="flex-1 py-2 bg-red-600 text-white rounded-xl font-semibold text-sm disabled:opacity-50 hover:bg-red-700 transition-colors"
              >
                {isClosing ? 'Menutup…' : 'Tutup Shift'}
              </button>
              <button
                onClick={() => setShowCloseModal(false)}
                className="flex-1 py-2 border border-gray-200 rounded-xl font-semibold text-sm text-gray-600"
              >
                Batal
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
})
