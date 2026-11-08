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
import { useKoneksiData, useOfflineStart } from '../hooks/useKoneksiData'
import { useStockPending } from '../hooks/useStockPending'
import { queuedTimeText } from '../lib/queuedSales'
import { formatRupiah } from '../cashier/pricing'
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
const OFFLINE_BASE =
  'Transaksi disimpan di tablet dan terkirim otomatis saat online. Terkunci otomatis jika offline lebih dari 12 jam'
const OFFLINE_SENTENCE = `${OFFLINE_BASE}.`
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

const COUNT_PILL = 'rounded-chip px-2 py-0.5 text-xs font-bold tnum'

function SectionHeading({ tone, children, count }: { tone: 'warn' | 'danger'; children: ReactNode; count: number }) {
  const heading = tone === 'warn' ? 'text-warn-strong' : 'text-danger'
  const pill = tone === 'warn' ? 'bg-warn-bg text-warn-strong' : 'bg-danger-bg text-danger'
  return (
    <h3 className={`flex items-center gap-2 font-bold ${heading}`}>
      {children}
      <span className={`${COUNT_PILL} ${pill}`}>{count}</span>
    </h3>
  )
}

/** One parked item: what it is, what the cashier captured (e.g. a refund's order, amount and method), why it is parked. */
export function ReviewRow({ f, onRetry, onAcknowledge }: { f: FailedItem; onRetry?: (key: string) => void; onAcknowledge?: (key: string) => void }) {
  const label = typeLabel(f.type)
  const [showDetail, setShowDetail] = useState(false)
  return (
    <div className="rounded-control border border-danger bg-danger-bg px-3 py-3 space-y-1" data-testid="review-row" data-key={f.idempotencyKey}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-bold text-ink-900 break-words">
          {label}
          {f.detail && <span> · {f.detail}</span>}
        </p>
        {f.clientCreatedAt && <p className="flex-shrink-0 text-xs text-ink-500 tnum">{formatTime(f.clientCreatedAt)}</p>}
      </div>
      {f.ownedBy && <p className="text-xs font-semibold text-danger">milik akun {f.ownedBy}</p>}
      <p className="text-xs text-danger">{PARKED_SENTENCE}</p>
      {f.reported && <p className="text-xs font-semibold text-danger">Dilaporkan ke kantor pusat</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {onRetry && (
          <button
            type="button"
            aria-label={`Coba lagi: ${label}${f.clientCreatedAt ? ` ${formatTime(f.clientCreatedAt)}` : ''}`}
            onClick={() => onRetry(f.idempotencyKey)}
            className="press min-h-11 rounded-control border border-danger bg-white px-4 text-sm font-semibold text-danger active:bg-danger-bg"
          >
            Coba lagi
          </button>
        )}
        <button
          type="button"
          aria-expanded={showDetail}
          onClick={() => setShowDetail((v) => !v)}
          className="press min-h-11 rounded-control bg-paper-1 px-4 text-sm font-semibold text-ink-900"
        >
          Detail teknis
        </button>
      </div>
      {showDetail && <p className="break-words pt-1 text-xs text-danger">{f.lastError ?? 'Alasan tidak diketahui'}</p>}
      {onAcknowledge && (
        <Button variant="ghost" onClick={() => onAcknowledge(f.idempotencyKey)}>
          Tandai sudah ditangani
        </Button>
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
  stockPending: boolean
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
    return `${OFFLINE_BASE} (${left} jam lagi).`
  }
  if (o.pendingCount > 0) return 'Transaksi tersimpan di tablet dan sedang dikirim.'
  if (o.wallRaised) return o.autoUpdate ? 'Diperbarui otomatis saat keranjang kosong.' : null
  // No promise of an automatic update: the stock pull has its own hourly cap that autoUpdate does not reflect.
  if (o.stockPending) return 'Transaksi terkirim. Stok produk belum diperbarui; tekan Perbarui stok untuk memperbarui sekarang.'
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
  /** Stock drift not pulled yet (F19). Normally read from the engine by the component; a prop for tests. */
  stockPending?: boolean
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
  stockPending: stockPendingProp,
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
  const enginePending = useStockPending()
  // Only stock-only changes: a raised data wall already has its own chip and button.
  const stockPending = isOnline && !updateAvailable && (stockPendingProp ?? enginePending)

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
    stockPending,
  })
  const { queued, dataUpdatedAt, now } = useKoneksiData(open, pendingCount)
  const offlineStart = useOfflineStart(isOnline || offlineCap?.level === 'locked' ? null : (offlineCap?.offlineMs ?? null))
  const offlineSince = offlineStart === null ? '' : queuedTimeText(new Date(offlineStart).toISOString(), now)
  const otherQueued = Math.max(0, pendingCount - queued.length)
  // A parked item outranks the offline note: its count stays the title.
  const statusTitle = offlineSince && review.length === 0 ? `Offline sejak ${offlineSince} · penjualan tetap bisa` : chip.text
  const note = explanation({ isOnline, cap: offlineCap, accountProblem, wallRaised: updateAvailable, stockPending, autoUpdate, pendingCount })
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
            <p className="flex items-center gap-2 font-bold">
              <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-current" />
              {statusTitle}
            </p>
            {note && <p className="text-xs">{note}</p>}
            {/* The title or the section headings show the counts; this line stays for screen readers and the tests that read it. */}
            {(pendingCount > 0 || review.length > 0) && <p className="sr-only" data-testid="queue-counts">{queueCountsLine({ pending: pendingCount, parked: review.length }).text}</p>}
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
            <section className="space-y-2" data-testid="queued-sales">
              <SectionHeading tone="warn" count={pendingCount}>Tersimpan di tablet</SectionHeading>
              {queued.length === 0 && <p className="text-xs text-ink-500">Aman. Akan terkirim otomatis saat online.</p>}
              {queued.map((q) => (
                <div key={q.key} className="surface-card flex items-center justify-between gap-3 rounded-control px-3 py-2" data-testid="queued-sale">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink-900">#{q.number} · Penjualan · {q.methodLabel}</p>
                    <p className="text-xs text-ink-500 tnum">{queuedTimeText(q.capturedAt, now)}</p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    {q.total !== null && <span className="font-bold text-ink-900 tnum">{formatRupiah(q.total)}</span>}
                    <span className="rounded-chip bg-warn-bg px-2.5 py-1 text-xs font-bold text-warn-strong">Menunggu</span>
                  </div>
                </div>
              ))}
              {queued.length > 0 && otherQueued > 0 && (
                <p className="text-xs text-ink-500">Dan {otherQueued} transaksi lain yang juga menunggu.</p>
              )}
            </section>
          )}

          {hasFailed && (
            <section className="space-y-2">
              <SectionHeading tone="danger" count={review.length}>Perlu ditinjau</SectionHeading>
              <div className="space-y-2">{rows.map((f) => <ReviewRow key={f.idempotencyKey} f={f} onRetry={onRetryOne} onAcknowledge={onAcknowledge} />)}</div>
              {hiddenCount > 0 && <p className="text-xs text-ink-500">{hiddenCount} transaksi sudah ditandai ditangani; tetap tersimpan di tablet. Coba lagi mengirimnya lagi.</p>}
              <p className="text-xs text-ink-500">Data tetap tersimpan di perangkat dan tidak dikirim ulang otomatis.</p>
              {(!onRetryOne || rows.length > 1 || hiddenCount > 0) && (
                <button
                  type="button"
                  onClick={() => { onRetryFailed(); setOpen(false) }}
                  className="press min-h-12 w-full rounded-control border border-danger bg-white px-4 text-sm font-semibold text-danger active:bg-danger-bg"
                >
                  {onRetryOne ? 'Coba lagi semua' : 'Coba lagi'}
                </button>
              )}
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

          {dataUpdatedAt !== null && (
            <p className="flex items-center gap-2 text-xs font-semibold text-ink-700" data-testid="data-freshness">
              <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-info" />
              Data produk, stok &amp; promo: diperbarui {queuedTimeText(new Date(dataUpdatedAt).toISOString(), now)}
            </p>
          )}

          <TechnicalDetail>
            <p>
              Versi data lokal {wall.localVersion} · server {wall.serverVersion}
            </p>
          </TechnicalDetail>
        </div>

        <div className="border-t border-paper-2 px-4 py-3">
          {canFlush || updateAvailable || stockPending || hasFailed ? (
            <div className="flex gap-2">
              {canFlush && (
                <Button className="flex-1" onClick={() => { onFlush(); setOpen(false) }}>
                  Kirim sekarang ({pendingCount})
                </Button>
              )}
              {(updateAvailable || stockPending) && (
                <Button
                  variant={canFlush ? 'secondary' : 'primary'}
                  className="flex-1"
                  disabled={isResyncing}
                  onClick={() => { onResync(); setOpen(false) }}
                >
                  {isResyncing ? 'Memperbarui data…' : updateAvailable ? 'Perbarui data' : 'Perbarui stok'}
                </Button>
              )}
              {hasFailed && (
                <Button variant="secondary" className="flex-1" onClick={onExportLog}>
                  Bagikan log
                </Button>
              )}
            </div>
          ) : (
            offlineCap?.level !== 'locked' && <p className="py-2 text-center text-sm text-ink-500">Tidak ada yang perlu dilakukan</p>
          )}
        </div>
      </Sheet>
    </div>
  )
})
