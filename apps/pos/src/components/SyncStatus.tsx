/**
 * Non-blocking sync indicator (replaces the old blocking SyncWall modal).
 * A compact chip beside the shift bar; tap to see detail:
 *  - offline / syncing / synced
 *  - "update available" (backoffice bumped reference data) → resync
 *  - failed items → the server's reject reason + a manual retry
 * Selling is never blocked; the cashier decides when to sync.
 */
import { memo, useEffect, useState } from 'react'
import type { WallState } from '@mandalika/sync'
import type { FailedItem } from '../hooks/useOfflineData'

interface SyncStatusProps {
  isOnline: boolean
  pendingCount: number
  failed: FailedItem[]
  wall: WallState
  isResyncing: boolean
  onResync: () => void
  onFlush: () => void
  onRetryFailed: () => void
  /** Record the failed items to the debug log + share, then dismiss them. */
  onSendLog: () => void
}

export const SyncStatus = memo(function SyncStatus({
  isOnline,
  pendingCount,
  failed,
  wall,
  isResyncing,
  onResync,
  onFlush,
  onRetryFailed,
  onSendLog,
}: SyncStatusProps) {
  const [open, setOpen] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  // Disarm the destructive discard whenever the dropdown closes, so reopening
  // always starts from the safe (un-armed) state regardless of how it closed.
  useEffect(() => {
    if (!open) setConfirmingDiscard(false)
  }, [open])

  const hasFailed = failed.length > 0
  const saleCount = failed.filter(
    (f) => f.type === 'order' || f.type === 'refund',
  ).length
  const updateAvailable = wall.raised

  let label: string
  let tone: string
  if (!isOnline) {
    label = 'Offline'
    tone = 'bg-amber-100 text-amber-700'
  } else if (hasFailed) {
    label = `Sinkron gagal (${failed.length})`
    tone = 'bg-red-100 text-red-700'
  } else if (pendingCount > 0) {
    label = `Menyinkronkan ${pendingCount}…`
    tone = 'bg-amber-100 text-amber-700'
  } else if (updateAvailable) {
    label = 'Pembaruan tersedia'
    tone = 'bg-blue-100 text-blue-700'
  } else {
    label = 'Tersinkron'
    tone = 'bg-green-100 text-green-700'
  }

  return (
    <div className="relative">
      <button type="button"
        onClick={() => setOpen((v) => !v)}
        className={`px-2 py-1 rounded-lg text-[11px] font-bold ${tone}`}
        title="Status sinkronisasi"
      >
        {label}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Tutup"
            tabIndex={-1}
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-xl z-50 p-3 text-xs space-y-2">
            <div className="flex justify-between text-gray-600">
              <span>Status</span>
              <span className="font-semibold">{label}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>Versi data</span>
              <span>
                lokal {wall.localVersion} · server {wall.serverVersion}
              </span>
            </div>

            {updateAvailable && (
              <button type="button"
                onClick={() => { onResync(); setOpen(false) }}
                disabled={isResyncing}
                className="w-full py-2 bg-blue-600 text-white rounded-lg font-semibold disabled:opacity-50"
              >
                {isResyncing ? 'Menyinkronkan…' : 'Sinkronkan data terbaru'}
              </button>
            )}

            {pendingCount > 0 && !hasFailed && (
              <button type="button"
                onClick={() => { onFlush(); setOpen(false) }}
                className="w-full py-2 bg-amber-500 text-white rounded-lg font-semibold"
              >
                Kirim {pendingCount} antrian sekarang
              </button>
            )}

            {hasFailed && (
              <div className="space-y-1">
                <p className="font-semibold text-red-700">
                  {failed.length} transaksi gagal sinkron
                </p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {failed.map((f) => (
                    <div
                      key={f.idempotencyKey}
                      className="bg-red-50 rounded-lg px-2 py-1.5"
                    >
                      <p className="font-semibold text-red-700">{f.type}</p>
                      <p className="text-[10px] text-red-600 break-words">
                        {f.lastError ?? 'unknown error'}
                      </p>
                    </div>
                  ))}
                </div>
                <button type="button"
                  onClick={() => { onRetryFailed(); setOpen(false) }}
                  className="w-full py-2 bg-red-600 text-white rounded-lg font-semibold"
                >
                  Coba lagi
                </button>
                {!confirmingDiscard ? (
                  <button type="button"
                    onClick={() => setConfirmingDiscard(true)}
                    className="w-full py-2 border border-red-200 text-red-600 rounded-lg font-semibold"
                  >
                    Kirim Log &amp; Tutup
                  </button>
                ) : (
                  <div className="space-y-1.5 rounded-lg bg-red-50 p-2">
                    <p className="text-[11px] font-semibold text-red-700 leading-tight">
                      {saleCount > 0
                        ? `⚠️ ${saleCount} penjualan/refund belum tercatat & akan hilang permanen.`
                        : `${failed.length} item gagal sinkron akan dihapus.`}
                    </p>
                    <div className="flex gap-2">
                      <button type="button"
                        onClick={() => setConfirmingDiscard(false)}
                        className="flex-1 py-2 border border-gray-200 text-gray-600 rounded-lg font-semibold"
                      >
                        Batal
                      </button>
                      <button type="button"
                        onClick={() => { onSendLog(); setOpen(false) }}
                        className="flex-1 py-2 bg-red-600 text-white rounded-lg font-semibold"
                      >
                        Ya, hapus
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!updateAvailable && pendingCount === 0 && !hasFailed && (
              <p className="text-gray-400 text-center">Semua tersinkron ✓</p>
            )}
          </div>
        </>
      )}
    </div>
  )
})
