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
import { OFFLINE_LOCKED_MESSAGE, offlineHours, offlineWarnMessage } from '../lib/offlineCap'
import { Button, Chip, Sheet, StatusBadge, toneClasses } from './ui'

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
export function ReviewRow({ f }: { f: FailedItem }) {
  return (
    <div className="bg-danger-bg rounded-lg px-3 py-2">
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
  /** Controlled sheet state (lets the Android Back handler close it); falls back to local state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
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
  open: openProp,
  onOpenChange,
}: SyncStatusProps) {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = openProp ?? innerOpen
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setInnerOpen(v))
  const hasFailed = review.length > 0
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
        panelClassName="flex flex-col"
        title={<span className="block px-4 pt-4 pb-2 pr-28 text-lg">Koneksi &amp; antrean</span>}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-2 top-2 min-h-11 px-4 text-sm font-semibold text-ink-700"
        >
          Kembali
        </button>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3 text-sm">
          <div className={`rounded-xl px-4 py-3 space-y-1 ${toneClasses(chip.tone)}`}>
            <p className="font-semibold">{chip.text}</p>
            {note && <p className="text-xs">{note}</p>}
          </div>

          {pendingCount > 0 && (
            <section className="space-y-1">
              <h3 className="font-semibold text-ink-900">Tersimpan di tablet ({pendingCount})</h3>
              <p className="text-xs text-ink-500">Aman. Akan terkirim otomatis saat online.</p>
            </section>
          )}

          {hasFailed && (
            <section className="space-y-2">
              <h3 className="font-semibold text-danger">Perlu ditinjau ({review.length})</h3>
              <div className="space-y-2">{review.map((f) => <ReviewRow key={f.idempotencyKey} f={f} />)}</div>
              <p className="text-xs text-ink-500">Data tetap tersimpan di perangkat dan tidak dikirim ulang otomatis.</p>
              <Button variant="danger" fullWidth onClick={() => { onRetryFailed(); setOpen(false) }}>
                Coba lagi
              </Button>
            </section>
          )}

          {showStuck && (
            <section className="space-y-2">
              <h3 className="font-semibold text-warn">Tertunda berulang ({stuck.length})</h3>
              {stuck.map((f) => (
                <div key={f.idempotencyKey} className="bg-warn-bg rounded-lg px-3 py-2">
                  <p className="font-semibold text-warn">{typeLabel(f.type)}</p>
                  <p className="text-xs text-warn break-words">{f.lastError}</p>
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
            <StatusBadge tone="ok" size="md" label="Tidak ada yang perlu dilakukan" />
          )}
        </div>
      </Sheet>
    </div>
  )
})
