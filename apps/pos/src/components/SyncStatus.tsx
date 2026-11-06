/**
 * The one connection + queue indicator (replaces the old blocking SyncWall modal and the popover).
 * A chip beside the shift bar whose text comes from `chipModel` (UX direction 3.5); tapping it opens the
 * "Koneksi & antrean" sheet:
 *  - a status card with one explanatory sentence
 *  - items saved on the tablet (count) and items needing review ("Perlu ditinjau"): type, time, detail,
 *    a plain sentence, and the raw error behind "Detail teknis". They are kept, never auto-retried, never deleted
 *  - actions: Kirim sekarang, Perbarui data, Bagikan log
 * Selling is never blocked here. Reference data is pulled automatically while the cart is empty and no flow is
 * open (see the engine's auto-pull); "Perbarui data" stays as a fallback.
 */
import { memo, useState, type ReactNode } from 'react'
import type { OfflineCapState, WallState } from '@mandalika/sync'
import type { FailedItem } from '../hooks/useOfflineData'
import { chipModel } from '../lib/connectionChip'
import { queueCountsLine } from '../lib/queueGuard'
import { OFFLINE_LOCKED_MESSAGE, offlineHours, offlineWarnMessage } from '../lib/offlineCap'
import { OTA_BLOCK_COPY, type OtaBlockReason } from '../lib/otaApplyGate'
import { Button, Chip, Sheet, toneClasses } from './ui'

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

const PARKED_SENTENCE = 'Tidak bisa terkirim setelah beberapa kali coba. Hubungi admin. Transaksi aman di tablet ini.'
const OFFLINE_SENTENCE =
  'Transaksi disimpan di tablet dan terkirim otomatis saat online. Terkunci otomatis jika offline lebih dari 12 jam.'
const CAP_HOURS = 12
const HOUR_MS = 3_600_000

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function TechnicalDetail({ children }: { children: ReactNode }) {
  return (
    <details className="text-xs text-ink-500">
      <summary className="min-h-11 flex items-center cursor-pointer font-semibold">Detail teknis</summary>
      <div className="space-y-1 break-words pb-2">{children}</div>
    </details>
  )
}

/** One parked item: what it is, what the cashier captured (e.g. a refund's order, amount and method), why it is parked. */
export function ReviewRow({ f, onRetry, onAcknowledge }: { f: FailedItem; onRetry?: (key: string) => void; onAcknowledge?: (key: string) => void }) {
  const label = typeLabel(f.type)
  return (
    <div className="bg-danger-bg rounded-control px-3 py-2" data-testid="review-row" data-key={f.idempotencyKey}>
      <p className="font-semibold text-danger">
        {typeLabel(f.type)}
        {f.clientCreatedAt && <span className="font-normal"> · {formatTime(f.clientCreatedAt)}</span>}
      </p>
      {f.detail && <p className="text-sm font-semibold text-danger break-words">{f.detail}</p>}
      {f.ownedBy && <p className="text-xs font-semibold text-danger">milik akun {f.ownedBy}</p>}
      <p className="text-xs text-danger">{PARKED_SENTENCE}</p>
      {f.reported && <p className="text-xs font-semibold text-danger">Dilaporkan ke kantor pusat</p>}
      <TechnicalDetail>
        <p>{f.lastError ?? 'Alasan tidak diketahui'}</p>
      </TechnicalDetail>
      {(onRetry || onAcknowledge) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {onRetry && (
            <Button variant="secondary" aria-label={`Coba lagi: ${label}${f.clientCreatedAt ? ` ${formatTime(f.clientCreatedAt)}` : ''}`} onClick={() => onRetry(f.idempotencyKey)}>
              Coba lagi
            </Button>
          )}
          {onAcknowledge && (
            <Button variant="ghost" onClick={() => onAcknowledge(f.idempotencyKey)}>
              Tandai sudah ditangani
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** One explanatory sentence under the status text (section 3.5/3.6 copy). */
function explanation(o: {
  isOnline: boolean
  cap?: OfflineCapState
  accountProblem: string | null
  wallRaised: boolean
  autoUpdate: boolean
  pendingCount: number
}): string | null {
  if (o.accountProblem && o.isOnline) return o.accountProblem
  if (!o.isOnline) {
    if (o.cap?.level === 'locked') return OFFLINE_LOCKED_MESSAGE
    const nudge = o.cap ? offlineWarnMessage(o.cap) : null
    if (nudge) return `${nudge} ${OFFLINE_SENTENCE}`
    if (o.cap?.offlineMs == null) return OFFLINE_SENTENCE
    const left = Math.max(0, Math.ceil(CAP_HOURS - o.cap.offlineMs / HOUR_MS))
    return `${OFFLINE_SENTENCE} Sisa sekitar ${left} jam.`
  }
  if (o.pendingCount > 0) return 'Transaksi tersimpan di tablet dan sedang dikirim.'
  if (o.wallRaised) return o.autoUpdate ? 'Diperbarui otomatis saat keranjang kosong.' : null
  return 'Semua transaksi sudah terkirim.'
}

/** C5 (D-19): a downloaded app version waiting for a restart. Absent when nothing is waiting (always, off-device). */
export interface OtaUpdateView {
  version: string
  /** Why the restart must wait right now; null = the cashier may restart. */
  blockedBy: OtaBlockReason | null
  applying: boolean
  error: string | null
  onRestart: () => void
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
  /** C2: re-queue ONE parked item. */
  onRetryOne?: (idempotencyKey: string) => void
  /** C2: hide a parked row locally once it was handled; never deletes the stored item. */
  onAcknowledge?: (idempotencyKey: string) => void
  /** Parked items marked as handled: their rows are hidden, but they are still parked and counted. */
  acknowledged?: ReadonlySet<string>
  /** Share diagnostics without resolving or removing failed operations. */
  onExportLog: () => void
  /** Controlled sheet state (lets the Android Back handler close it); falls back to local state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  otaUpdate?: OtaUpdateView | null
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
  onRetryOne,
  onAcknowledge,
  acknowledged,
  onExportLog,
  open: openProp,
  onOpenChange,
  otaUpdate = null,
}: SyncStatusProps) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = openProp ?? innerOpen
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInnerOpen(v))
  const hasFailed = review.length > 0
  const rows = acknowledged ? review.filter((f) => !acknowledged.has(f.idempotencyKey)) : review
  const hiddenCount = review.length - rows.length
  // Offline is its own, normal state: never describe it as a server problem.
  const showStuck = isOnline && stuck.length > 0
  const showAccount = isOnline && accountProblem !== null
  const updateAvailable = wall.raised

  const chip = chipModel({
    reachable: isOnline,
    offlineLevel: offlineCap?.level ?? 'unknown',
    offlineHours: offlineCap ? offlineHours(offlineCap) : undefined,
    pending: pendingCount,
    stuck: showStuck ? stuck.length : 0,
    parked: review.length,
    accountIssue: showAccount,
    updating: isResyncing,
    wallRaised: updateAvailable,
  })
  const note = explanation({ isOnline, cap: offlineCap, accountProblem, wallRaised: updateAvailable, autoUpdate, pendingCount })
  const canFlush = pendingCount > 0 && !hasFailed

  return (
    <div className="relative">
      <Chip selected toggle={false} tone={chip.tone} dot onClick={() => setOpen(true)}>
        {chip.text}
      </Chip>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        variant="side"
        maxWidth="max-w-md"
        z={50}
        panelClassName="flex flex-col overflow-hidden"
        header
        title="Koneksi &amp; antrean"
      >
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 text-sm">
          <div className={`rounded-control px-4 py-3 space-y-1 ${toneClasses(chip.tone)}`}>
            <p className="font-semibold">{chip.text}</p>
            {note && <p className="text-xs">{note}</p>}
            {(pendingCount > 0 || review.length > 0) && <p className="text-xs font-semibold" data-testid="queue-counts">{queueCountsLine({ pending: pendingCount, parked: review.length }).text}</p>}
          </div>

          {otaUpdate && (
            <section className="rounded-control bg-info-bg px-4 py-3 space-y-2 text-info" data-testid="ota-update">
              <h3 className="font-semibold">Versi baru siap ({otaUpdate.version})</h3>
              <p className="text-xs">Versi baru siap, mulai ulang saat kasir kosong.</p>
              {otaUpdate.blockedBy && <p className="text-xs font-semibold" data-testid="ota-block-reason">{OTA_BLOCK_COPY[otaUpdate.blockedBy]}</p>}
              {otaUpdate.error && <p className="text-xs font-semibold text-danger" role="alert">{otaUpdate.error}</p>}
              <Button fullWidth disabled={otaUpdate.blockedBy !== null || otaUpdate.applying} onClick={otaUpdate.onRestart}>
                {otaUpdate.applying ? 'Memulai ulang…' : 'Mulai ulang sekarang'}
              </Button>
            </section>
          )}

          {pendingCount > 0 && (
            <section className="space-y-1">
              <h3 className="font-semibold text-ink-900">Tersimpan di tablet ({pendingCount})</h3>
              <p className="text-xs text-ink-500">Aman. Akan terkirim otomatis saat online.</p>
            </section>
          )}

          {hasFailed && (
            <section className="space-y-2">
              <h3 className="font-semibold text-danger">Perlu ditinjau ({review.length})</h3>
              <div className="space-y-2">{rows.map((f) => <ReviewRow key={f.idempotencyKey} f={f} onRetry={onRetryOne} onAcknowledge={onAcknowledge} />)}</div>
              {hiddenCount > 0 && <p className="text-xs text-ink-500">{hiddenCount} transaksi sudah ditandai ditangani; tetap tersimpan di tablet. Coba lagi mengirimnya lagi.</p>}
              <p className="text-xs text-ink-500">Data tetap tersimpan di perangkat dan tidak dikirim ulang otomatis.</p>
              <button
                type="button"
                onClick={() => { onRetryFailed(); setOpen(false) }}
                className="press min-h-12 w-full rounded-control border border-danger bg-white px-4 text-sm font-semibold text-danger active:bg-danger-bg"
              >
                Coba lagi
              </button>
            </section>
          )}

          {showStuck && (
            <section className="space-y-2">
              <h3 className="font-semibold text-warn-strong">Tertunda berulang ({stuck.length})</h3>
              {stuck.map((f) => (
                <div key={f.idempotencyKey} className="bg-warn-bg rounded-control px-3 py-2">
                  <p className="font-semibold text-warn-strong">{typeLabel(f.type)}</p>
                  <p className="text-xs text-warn-strong break-words">{f.lastError}</p>
                </div>
              ))}
            </section>
          )}

          <TechnicalDetail>
            <p>
              Versi data lokal {wall.localVersion} · server {wall.serverVersion}
            </p>
          </TechnicalDetail>
        </div>

        <div className="border-t border-paper-2 px-4 py-3 space-y-2">
          {canFlush && (
            <Button fullWidth onClick={() => { onFlush(); setOpen(false) }}>
              Kirim sekarang ({pendingCount})
            </Button>
          )}
          {updateAvailable && (
            <Button
              variant={canFlush ? 'secondary' : 'primary'}
              fullWidth
              disabled={isResyncing}
              onClick={() => { onResync(); setOpen(false) }}
            >
              {isResyncing ? 'Memperbarui data…' : 'Perbarui data'}
            </Button>
          )}
          {hasFailed && (
            <Button variant="secondary" fullWidth onClick={onExportLog}>
              Bagikan log
            </Button>
          )}
          {!canFlush && !updateAvailable && !hasFailed && offlineCap?.level !== 'locked' && (
            <p className="py-2 text-center text-sm text-ink-500">Tidak ada yang perlu dilakukan</p>
          )}
        </div>
      </Sheet>
    </div>
  )
})
