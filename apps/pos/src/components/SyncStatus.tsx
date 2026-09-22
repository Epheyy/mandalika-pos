/**
 * Non-blocking sync indicator (replaces the old blocking SyncWall modal).
 * A compact chip beside the shift bar; tap to see detail:
 *  - offline / syncing / synced
 *  - "update available" (backoffice bumped reference data) → resync
 *  - failed items → the server's reject reason + a manual retry
 * Selling is never blocked; the cashier decides when to sync.
 */
import { memo, useState } from 'react'
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
  /** Share diagnostics without resolving or removing failed operations. */
  onExportLog: () => void
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
  onExportLog,
}: SyncStatusProps) {
  const [open, setOpen] = useState(false)
  const hasFailed = failed.length > 0
  const updateAvailable = wall.raised

  let label: string
  let tone: string
  if (!isOnline) {
    label = hasFailed ? `Offline · ${failed.length} gagal` : 'Offline'
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
                <button type="button"
                  onClick={onExportLog}
                  className="w-full py-2 border border-red-200 text-red-600 rounded-lg font-semibold"
                >
                  Bagikan log diagnostik
                </button>
                <p className="text-[11px] text-gray-500">
                  Transaksi tetap tersimpan dan perlu disinkronkan.
                </p>
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
