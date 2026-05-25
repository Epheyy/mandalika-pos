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

interface ConfirmItem {
  productId: string
  variantSize: string
  receivedQty: number
}

interface Props {
  transfers: Transfer[]
  onClose: () => void
  onConfirm: (transferId: string, items: ConfirmItem[], discrepancyReason: string) => void
}

/** Stable key for a line item within a transfer. */
function lineKey(productId: string, variantSize: string): string {
  return `${productId}|${variantSize}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Public panel — switches between list and form views
// ─────────────────────────────────────────────────────────────────────────────

export function ReceiveTransferPanel({ transfers, onClose, onConfirm }: Props) {
  const [selected, setSelected] = useState<Transfer | null>(null)

  if (!selected) {
    return (
      <InboundList
        transfers={transfers}
        onClose={onClose}
        onSelect={setSelected}
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
  onClose: () => void
  onSelect: (t: Transfer) => void
}

function InboundList({ transfers, onClose, onSelect }: InboundListProps) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="font-bold text-gray-900">Terima Transfer</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Tutup"
          >
            ✕
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {transfers.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">
              Tidak ada transfer masuk.
            </p>
          ) : (
            <div className="space-y-2">
              {transfers.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSelect(t)}
                  className="w-full text-left px-4 py-3 border border-gray-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50 transition-all group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-gray-900 group-hover:text-indigo-700 transition-colors">
                        {t.transferNo}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                        Dari {t.source.name ?? t.source.id} · {t.items.length} item
                      </p>
                    </div>
                    <span className="text-gray-400 group-hover:text-indigo-400 flex-shrink-0 text-lg leading-none">›</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 flex-shrink-0"
            aria-label="Kembali"
          >
            ‹
          </button>
          <div className="min-w-0">
            <h3 className="font-bold text-gray-900 truncate">
              Terima {transfer.transferNo}
            </h3>
            <p className="text-[11px] text-gray-400 truncate">
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
                className={`border rounded-xl px-4 py-3 transition-colors ${hasDiff ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}
              >
                {/* Product name + variant */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-gray-900 truncate">
                      {it.productName}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {it.variantSize}
                      {it.sku ? ` · ${it.sku}` : ''}
                      {' · '}dikirim <span className="font-bold">{it.sentQty}</span>
                    </p>
                  </div>

                  {/* Difference badge */}
                  {hasDiff && diff !== null && (
                    <span
                      className={`flex-shrink-0 text-xs font-black px-2 py-0.5 rounded-full ${
                        diff < 0
                          ? 'bg-red-100 text-red-700'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {diff > 0 ? '+' : ''}{diff}
                    </span>
                  )}
                </div>

                {/* Qty input */}
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wide flex-shrink-0">
                    Diterima
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={currentVal}
                    onChange={(e) => handleQtyChange(key, e.target.value)}
                    className={`flex-1 min-w-0 px-3 py-1.5 border rounded-lg text-sm font-bold text-right focus:outline-none transition-colors ${
                      hasDiff
                        ? 'border-amber-300 bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-300'
                        : 'border-gray-200 bg-gray-50 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-300'
                    }`}
                  />
                </div>
              </div>
            )
          })}

          {/* Discrepancy reason — required when any line differs */}
          {anyDiff && (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3">
              <label className="block text-xs font-bold text-red-700 mb-1.5">
                Alasan selisih <span className="font-black">(wajib)</span>
              </label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Jelaskan penyebab selisih antara jumlah dikirim dan diterima…"
                className="w-full px-3 py-2 border border-red-200 bg-white rounded-lg text-sm resize-none focus:outline-none focus:ring-1 focus:ring-red-400 placeholder-gray-400"
              />
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-gray-100 flex-shrink-0 space-y-2">
          {anyDiff && !reason.trim() && (
            <p className="text-xs text-red-600 text-center font-semibold">
              Isi alasan selisih sebelum melanjutkan
            </p>
          )}
          <button
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl transition-all"
          >
            Terima
          </button>
          <button
            onClick={onBack}
            className="w-full py-2.5 border border-gray-200 text-gray-600 font-semibold text-sm rounded-xl hover:bg-gray-50 transition-all"
          >
            Kembali
          </button>
        </div>
      </div>
    </div>
  )
}
