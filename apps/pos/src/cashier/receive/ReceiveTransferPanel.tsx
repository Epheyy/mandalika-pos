/**
 * ReceiveTransferPanel — two views:
 *   1. Inbound list  — one row per in-transit transfer (transferNo, source, item count).
 *                      Tap a row → opens the receive form.
 *   2. Receive form  — per line: product + variant + pre-filled sentQty (informed count).
 *                      Receiver edits only differing lines; any difference makes the
 *                      discrepancy-reason field required.  Primary action "Terima" →
 *                      calls onConfirm(transferId, items, discrepancyReason).
 *
 * This panel does NOT verify the PIN — it hands the counted lines up via onConfirm;
 * the parent (E4) shows the PIN modal and enqueues via engine.enqueueTransferReceive.
 */
import { useMemo, useState } from 'react'
import type { Transfer } from './receiveTypes'
import { variantLabel } from '@mandalika/types'
import { Sheet } from '../../components/ui/Sheet'
import { Button } from '../../components/ui/Button'
import { StatusBadge } from '../../components/ui/StatusBadge'

interface ConfirmItem {
  productId: string
  variantSize: string
  receivedQty: number
}

const EMPTY_TRANSFERS: Transfer[] = []

interface Props {
  transfers: Transfer[]
  /** Recently-completed transfers eligible for tanda terima reprint. */
  completedTransfers?: Transfer[]
  onClose: () => void
  onConfirm: (transferId: string, items: ConfirmItem[], discrepancyReason: string) => void
  /** Called when the cashier taps "Cetak Ulang Tanda Terima" on a completed transfer. */
  onReprintTandaTerima?: (transfer: Transfer) => void
}

/** Stable key for a line item within a transfer. */
function lineKey(productId: string, variantSize: string): string {
  return `${productId}|${variantSize}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Public panel — switches between list and form views
// ─────────────────────────────────────────────────────────────────────────────

export function ReceiveTransferPanel({
  transfers,
  completedTransfers = EMPTY_TRANSFERS,
  onClose,
  onConfirm,
  onReprintTandaTerima,
}: Props) {
  const [selected, setSelected] = useState<Transfer | null>(null)

  if (!selected) {
    return (
      <InboundList
        transfers={transfers}
        completedTransfers={completedTransfers}
        onClose={onClose}
        onSelect={setSelected}
        onReprintTandaTerima={onReprintTandaTerima}
      />
    )
  }

  return (
    <ReceiveForm
      transfer={selected}
      onBack={() => setSelected(null)}
      onConfirm={onConfirm}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// View 1: Inbound list
// ─────────────────────────────────────────────────────────────────────────────

interface InboundListProps {
  transfers: Transfer[]
  completedTransfers: Transfer[]
  onClose: () => void
  onSelect: (t: Transfer) => void
  onReprintTandaTerima?: (transfer: Transfer) => void
}

function InboundList({ transfers, completedTransfers, onClose, onSelect, onReprintTandaTerima }: InboundListProps) {
  // Only show completed transfers that have a tanda terima number to reprint.
  const reprints = completedTransfers.filter(
    (t) => t.status === 'completed' && t.tandaTerimaNo,
  )

  return (
    <Sheet open variant="center" maxWidth="max-w-lg" onClose={onClose} header title="Terima Transfer" panelClassName="max-h-[90vh] flex flex-col">
        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* In-transit transfers */}
          <div className="space-y-2">
            {transfers.length === 0 ? (
              <p className="text-sm text-ink-500 py-4 text-center">
                Tidak ada transfer masuk.
              </p>
            ) : (
              transfers.map((t) => (
                <button type="button"
                  key={t.id}
                  onClick={() => onSelect(t)}
                  className="press surface-card w-full min-h-11 text-left px-4 py-3 rounded-control"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-ink-900">
                        {t.transferNo}
                      </p>
                      <p className="text-[11px] text-ink-700 mt-0.5 truncate">
                        Dari {t.source.name ?? t.source.id} · {t.items.length} item
                      </p>
                    </div>
                    <span className="text-ink-500 flex-shrink-0 text-lg leading-none">›</span>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Recently-completed transfers — reprint section */}
          {reprints.length > 0 && onReprintTandaTerima && (
            <div className="pt-2 border-t border-paper-2">
              <p className="text-[10px] font-bold text-ink-500 uppercase tracking-wide mb-2">
                Baru diterima
              </p>
              <div className="space-y-2">
                {reprints.map((t) => (
                  <div
                    key={t.id}
                    className="surface-card flex items-center justify-between gap-2 px-4 py-3 rounded-control"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-ink-900 truncate">
                        {t.transferNo}
                      </p>
                      <p className="text-[11px] text-ink-700 mt-0.5 truncate">
                        {t.tandaTerimaNo} · Dari {t.source.name ?? t.source.id}
                      </p>
                    </div>
                    <Button variant="secondary" onClick={() => onReprintTandaTerima(t)} className="flex-shrink-0 !min-h-11 !px-3 text-xs">
                      Cetak Ulang Tanda Terima
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
    </Sheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// View 2: Receive form
// ─────────────────────────────────────────────────────────────────────────────

interface ReceiveFormProps {
  transfer: Transfer
  onBack: () => void
  onConfirm: Props['onConfirm']
}

function ReceiveForm({ transfer, onBack, onConfirm }: ReceiveFormProps) {
  // Pre-fill every line with sentQty; receiver edits only lines that differ.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      transfer.items.map((it) => [
        lineKey(it.productId, it.variantSize),
        String(it.sentQty),
      ]),
    ),
  )
  const [reason, setReason] = useState('')

  const anyDiff = useMemo(
    () =>
      transfer.items.some((it) => {
        const v = Number(qty[lineKey(it.productId, it.variantSize)] ?? it.sentQty)
        return v !== it.sentQty
      }),
    [qty, transfer.items],
  )

  const canSubmit = !anyDiff || reason.trim().length > 0

  const handleConfirm = () => {
    if (!canSubmit) return
    const items: ConfirmItem[] = transfer.items.map((it) => {
      const raw = Number(qty[lineKey(it.productId, it.variantSize)] ?? it.sentQty)
      const receivedQty = Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 0
      return { productId: it.productId, variantSize: it.variantSize, receivedQty }
    })
    onConfirm(transfer.id, items, reason.trim())
  }

  const handleQtyChange = (key: string, raw: string) => {
    // Strip non-digit characters; allow empty string while typing
    const digits = raw.replace(/\D/g, '')
    setQty((prev) => ({ ...prev, [key]: digits }))
  }

  return (
    <Sheet open variant="center" maxWidth="max-w-lg" panelClassName="max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-paper-2 flex-shrink-0">
          <button type="button"
            onClick={onBack}
            className="press inline-flex h-11 w-11 items-center justify-center rounded-control active:bg-paper-1 text-ink-700 flex-shrink-0"
            aria-label="Kembali"
          >
            ‹
          </button>
          <div className="min-w-0">
            <h3 className="font-bold text-ink-900 truncate">
              Terima {transfer.transferNo}
            </h3>
            <p className="text-[11px] text-ink-500 truncate">
              Dari {transfer.source.name ?? transfer.source.id}
            </p>
          </div>
        </div>

        {/* Item lines */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {transfer.items.map((it) => {
            const key = lineKey(it.productId, it.variantSize)
            const currentVal = qty[key] ?? String(it.sentQty)
            const parsed = Number(currentVal)
            const isValid = currentVal !== '' && Number.isFinite(parsed) && parsed >= 0
            const diff = isValid ? Math.round(parsed) - it.sentQty : null
            const hasDiff = diff !== null && diff !== 0

            return (
              <div
                key={key}
                className={`rounded-control px-4 py-3 ${hasDiff ? 'bg-warn-bg border border-warn' : 'surface-card'}`}
              >
                {/* Product name + variant */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-ink-900 truncate">
                      {it.productName}
                    </p>
                    <p className="text-[11px] text-ink-700">
                      {variantLabel(it.variantSize) || null}
                      {it.sku ? `${variantLabel(it.variantSize) ? ' · ' : ''}${it.sku}` : ''}
                      {' · '}dikirim <span className="font-bold tnum">{it.sentQty}</span>
                    </p>
                  </div>

                  {/* Difference badge: short (negative) is danger, over (positive) is warn */}
                  {hasDiff && diff !== null && (
                    <StatusBadge
                      tone={diff < 0 ? 'danger' : 'warn'}
                      label={`${diff > 0 ? '+' : ''}${diff}`}
                      className="flex-shrink-0 font-black tnum"
                    />
                  )}
                </div>

                {/* Qty input */}
                <div className="flex items-center gap-2">
                  <label htmlFor={`receive-qty-${key}`} className="text-[10px] font-bold text-ink-500 uppercase tracking-wide flex-shrink-0">
                    Diterima
                  </label>
                  <input
                    id={`receive-qty-${key}`}
                    aria-label="Diterima"
                    type="text"
                    inputMode="numeric"
                    value={currentVal}
                    onChange={(e) => handleQtyChange(key, e.target.value)}
                    className={`tnum flex-1 min-w-0 min-h-11 px-3 py-1.5 border rounded-control text-sm font-bold text-right text-ink-900 bg-white focus:outline-none focus:border-ink-700 ${
                      hasDiff ? 'border-warn' : 'border-paper-2'
                    }`}
                  />
                </div>
              </div>
            )
          })}

          {/* Discrepancy reason — required when any line differs */}
          {anyDiff && (
            <div className="bg-warn-bg border border-warn rounded-control px-4 py-3">
              <label htmlFor="receive-alasan-selisih" className="block text-xs font-bold text-warn-strong mb-1.5">
                Alasan selisih <span className="font-black">(wajib)</span>
              </label>
              <textarea
                id="receive-alasan-selisih"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Jelaskan penyebab selisih antara jumlah dikirim dan diterima…"
                className="w-full px-3 py-2 border border-paper-2 bg-white rounded-control text-sm text-ink-900 resize-none focus:outline-none focus:border-ink-700 placeholder:text-ink-500"
              />
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-paper-2 flex-shrink-0 space-y-2">
          {anyDiff && !reason.trim() && (
            <p className="text-xs text-warn-strong text-center font-semibold">
              Isi alasan selisih sebelum melanjutkan
            </p>
          )}
          <Button fullWidth onClick={handleConfirm} disabled={!canSubmit}>
            Terima
          </Button>
          <Button variant="secondary" fullWidth onClick={onBack}>
            Kembali
          </Button>
        </div>
    </Sheet>
  )
}
