/**
 * Non-blocking sync indicator (replaces the old blocking SyncWall modal).
 * A compact chip beside the shift bar; tap to see detail:
 *  - offline / syncing / synced
 *  - "update available" (backoffice bumped reference data) → resync
 *  - items needing review ("Perlu ditinjau") → type, time, reason + a manual retry;
 *    they are kept, never auto-retried and never deleted
 *  - items still retrying after repeated server failures → listed separately
 * Selling is never blocked. Reference data is pulled automatically while the cart is empty and no flow is
 * open (see the engine's auto-pull); the manual sync button stays as a fallback.
 */
import { memo, useState } from 'react'
import type { OfflineCapState, WallState } from '@mandalika/sync'
import type { FailedItem } from '../hooks/useOfflineData'
import { OFFLINE_LOCKED_MESSAGE, offlineHours, offlineWarnMessage } from '../lib/offlineCap'

const TYPE_LABELS: Record<string, string> = {
  order: 'Penjualan',
  refund: 'Refund',
  shift_open: 'Buka shift',
  shift_close: 'Tutup shift',
  cash_flow: 'Kas masuk/keluar',
  customer_create: 'Pelanggan baru',
  transfer_receive: 'Penerimaan transfer',
}
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** One parked item: what it is, what the cashier captured (e.g. a refund's order, amount and method), why it is parked. */
export function ReviewRow({ f }: { f: FailedItem }) {
  return (
    <div className="bg-red-50 rounded-lg px-2 py-1.5">
      <p className="font-semibold text-red-700">
        {typeLabel(f.type)}
        {f.clientCreatedAt && (
          <span className="font-normal text-red-500"> · {formatTime(f.clientCreatedAt)}</span>
        )}
      </p>
      {f.detail && (
        <p className="text-[11px] font-semibold text-red-700 break-words">{f.detail}</p>
      )}
      {f.ownedBy && (
        <p className="text-[10px] font-semibold text-red-700">milik akun {f.ownedBy}</p>
      )}
      <p className="text-[10px] text-red-600 break-words">
        {f.lastError ?? 'Alasan tidak diketahui'}
      </p>
        {f.reported && <p className="text-[10px] font-semibold text-red-500">Dilaporkan ke kantor pusat</p>}
    </div>
  )
}

/** The 12 h offline-cap note (A05): a nudge from 10 h, the lock explanation at 12 h. */
export function OfflineCapNotice({ cap }: { cap: OfflineCapState }) {
  if (cap.level === 'warn') {
    return <p className="bg-amber-50 text-amber-800 rounded-lg px-2 py-1.5 font-semibold">{offlineWarnMessage(cap)}</p>
  }
  if (cap.level === 'locked') {
    return <p className="bg-red-50 text-red-700 rounded-lg px-2 py-1.5 font-semibold">{OFFLINE_LOCKED_MESSAGE}</p>
  }
  return null
}

interface SyncStatusProps {
  isOnline: boolean
  pendingCount: number
  /** Parked items needing review. */
  review: FailedItem[]
  /** Items still retrying that keep failing on the server. */
  stuck: FailedItem[]
  /** Account/session-level refusal of the whole queue; nothing was parked. */
  accountProblem?: string | null
  wall: WallState
  /** Where the tablet stands against the 12 h offline cap (A05). */
  offlineCap?: OfflineCapState
  isResyncing: boolean
  /** False while background pulls are suspended or capped: stop promising an automatic update. */
  autoUpdate?: boolean
  onResync: () => void
  onFlush: () => void
  onRetryFailed: () => void
  /** Share diagnostics without resolving or removing failed operations. */
  onExportLog: () => void
}

export const SyncStatus = memo(function SyncStatus({
  isOnline,
  pendingCount,
  review,
  stuck,
  accountProblem = null,
  wall,
  offlineCap,
  isResyncing,
  autoUpdate = true,
  onResync,
  onFlush,
  onRetryFailed,
  onExportLog,
}: SyncStatusProps) {
  const [open, setOpen] = useState(false)
  const hasFailed = review.length > 0
  // Offline is its own, normal state: never describe it as a server problem.
  const showStuck = isOnline && stuck.length > 0
  const showAccount = isOnline && accountProblem !== null
  const updateAvailable = wall.raised

  let label: string
  let tone: string
  if (!isOnline) {
    label = hasFailed ? `Offline · ${review.length} perlu ditinjau` : 'Offline'
    tone = 'bg-amber-100 text-amber-700'
    if (offlineCap?.level === 'warn') label = `Offline ${offlineHours(offlineCap)} jam`
    if (offlineCap?.level === 'locked') {
      label = 'Offline · terkunci'
      tone = 'bg-red-100 text-red-700'
    }
  } else if (hasFailed) {
    label = `Perlu ditinjau (${review.length})`
    tone = 'bg-red-100 text-red-700'
  } else if (showAccount) {
    label = 'Masalah akun/outlet'
    tone = 'bg-red-100 text-red-700'
  } else if (showStuck) {
    label = `Tertunda (${stuck.length})`
    tone = 'bg-amber-100 text-amber-700'
  } else if (pendingCount > 0) {
    label = `Menyinkronkan ${pendingCount}…`
    tone = 'bg-amber-100 text-amber-700'
  } else if (isResyncing) {
    label = 'Memperbarui...'
    tone = 'bg-blue-100 text-blue-700'
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

            {offlineCap && <OfflineCapNotice cap={offlineCap} />}

            {updateAvailable && autoUpdate && (
              <p className="text-gray-500">Diperbarui otomatis saat keranjang kosong.</p>
            )}

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
                  Perlu ditinjau ({review.length})
                </p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {review.map((f) => <ReviewRow key={f.idempotencyKey} f={f} />)}
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
                  Data tetap tersimpan di perangkat dan tidak dikirim ulang otomatis.
                </p>
              </div>
            )}

            {showAccount && (
              <p className="bg-red-50 text-red-700 rounded-lg px-2 py-1.5 font-semibold">
                {accountProblem}
              </p>
            )}

            {showStuck && (
              <div className="space-y-1">
                <p className="font-semibold text-amber-700">
                  Tertunda berulang ({stuck.length})
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {stuck.map((f) => (
                    <div key={f.idempotencyKey} className="bg-amber-50 rounded-lg px-2 py-1.5">
                      <p className="font-semibold text-amber-700">{typeLabel(f.type)}</p>
                      <p className="text-[10px] text-amber-700 break-words">{f.lastError}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!updateAvailable && pendingCount === 0 && !hasFailed && !showStuck && !showAccount && (
              <p className="text-gray-400 text-center">Semua tersinkron ✓</p>
            )}
          </div>
        </>
      )}
    </div>
  )
})
