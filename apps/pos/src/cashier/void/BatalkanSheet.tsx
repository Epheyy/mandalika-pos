import { memo, useState } from 'react'
import type { components } from '@mandalika/api'
import { VOID_NOTE_MAX, VOID_REASONS, voidReasonProblem } from './voidRules'
import { batalkanInput, countedLines, initialBatalkan, setStockChoice, type BatalkanInput, type BatalkanState } from './batalkanState'
import { formatRupiah } from '../pricing'
import { Sheet } from '../../components/ui/Sheet'
import { Banner } from '../../components/ui/Banner'
import { Button } from '../../components/ui/Button'
import { Chip } from '../../components/ui/Chip'

type Order = components['schemas']['Order']
type VoidPreview = components['schemas']['VoidPreview']

export const OPNAME_WARNING = 'Stock opname setelah transaksi ini sudah menghitung barang berikut.'
export const OPNAME_RESTOCK = 'kembalikan stok'
export const OPNAME_SKIP = 'sudah dikoreksi oleh stock opname'

export interface BatalkanSheetProps {
  order: Order | null
  /** Eligibility and counted stock lines from the server; null when offline (or it could not be fetched). */
  preview: VoidPreview | null
  /** Online and the preview is still on its way: confirm waits so the stock choices are never skipped. */
  previewLoading?: boolean
  /** Online and the preview could not be read: a retry is offered and confirm stays off. */
  previewFailed?: boolean
  onRetryPreview?: () => void
  isProcessing?: boolean
  error?: string | null
  onConfirm: (input: BatalkanInput) => void
  onClose: () => void
}

const CHOICES = [
  { id: 'perbaiki', label: 'Batalkan & perbaiki', hint: 'Batalkan lalu buat transaksi pengganti di keranjang.' },
  { id: 'saja', label: 'Batalkan saja', hint: 'Batalkan tanpa transaksi pengganti.' },
] as const

/** "Batalkan transaksi #<no>": reason, note, choice and (online, when a stock count covered the sale) the per-line stock
 *  choice. The body is keyed by the order so nothing carries over from a previous void. */
export const BatalkanSheet = memo(function BatalkanSheet(props: BatalkanSheetProps) {
  return props.order ? <BatalkanBody key={props.order.id} {...props} order={props.order} /> : null
})

export function BatalkanBody({ order, preview, previewLoading = false, previewFailed = false, onRetryPreview, isProcessing = false, error, onConfirm, onClose }: BatalkanSheetProps & { order: Order }) {
  const [s, setS] = useState<BatalkanState>(() => initialBatalkan(preview))
  const counted = countedLines(preview)
  const problem = voidReasonProblem(s.reason, s.note)
  const input = batalkanInput(s, preview)
  const ready = input !== null && !previewLoading && !previewFailed && !isProcessing
  const confirmLabel = s.choice === 'perbaiki' ? 'Batalkan & perbaiki' : 'Batalkan saja'

  return (
    <Sheet open variant="center" ariaLabel={`Batalkan transaksi #${order.orderNumber}`} maxWidth="max-w-lg" panelClassName="p-5 max-h-[92vh] overflow-y-auto">
      <h3 className="font-bold text-ink-900 mb-1">Batalkan transaksi #{order.orderNumber}</h3>
      <p className="text-xs text-ink-500 mb-3">Total {formatRupiah(order.total)}</p>

      {previewFailed && <Banner tone="warn" message="Gagal memeriksa stock opname" action={onRetryPreview ? { label: 'Coba lagi', onClick: onRetryPreview } : undefined} className="rounded-control mb-3" />}
      {previewLoading && <p className="text-xs text-ink-500 mb-3" role="status">Memeriksa stock opname…</p>}
      {preview && !preview.eligible && <Banner tone="danger" message={preview.refusal ?? 'Transaksi ini tidak dapat dibatalkan.'} className="rounded-control mb-3" />}

      <div role="group" aria-label="Pilihan pembatalan" className="grid grid-cols-2 gap-2 mb-3">
        {CHOICES.map((c) => (
          <button key={c.id} type="button" aria-pressed={s.choice === c.id} onClick={() => setS({ ...s, choice: c.id })}
            className={`text-left rounded-control px-3 py-2 press border-2 ${s.choice === c.id ? 'border-brand-strong bg-white' : 'border-transparent surface-card'}`}>
            <span className="block text-sm font-semibold text-ink-900">{c.label}</span>
            <span className="block text-xs text-ink-500">{c.hint}</span>
          </button>
        ))}
      </div>

      <p id="void-reason-label" className="block text-xs text-ink-700 font-semibold mb-1">Alasan *</p>
      <div role="group" aria-labelledby="void-reason-label" className="flex flex-wrap gap-2 mb-2">
        {VOID_REASONS.map((r) => (
          <Chip key={r.code} selected={s.reason === r.code} onClick={() => setS({ ...s, reason: r.code })}>{r.label}</Chip>
        ))}
      </div>
      <label htmlFor="void-note" className="block text-xs text-ink-700 mb-1">{s.reason === 'lainnya' ? 'Catatan (wajib)' : 'Catatan (opsional)'}</label>
      <textarea id="void-note" value={s.note} onChange={(e) => setS({ ...s, note: e.target.value })} rows={2} maxLength={VOID_NOTE_MAX}
        placeholder="Tulis catatan pembatalan…"
        className="w-full surface-card rounded-control px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong mb-1 resize-none" />
      <p className="text-xs text-right mb-2 text-ink-500">{[...s.note].length}/{VOID_NOTE_MAX}</p>
      {s.reason !== null && problem && <p className="text-xs font-semibold text-warn-strong mb-2" role="status">{problem}</p>}

      {counted.length > 0 && (
        <div className="mb-3" data-testid="void-opname">
          <p className="text-xs font-semibold text-warn-strong bg-warn-bg border border-warn/30 rounded-control px-3 py-2 mb-2">{OPNAME_WARNING}</p>
          <div className="rounded-control surface-group divide-y divide-paper-2">
            {counted.map((l) => (
              <div key={l.key} className="px-3 py-2" data-testid="void-opname-line">
                <p className="text-sm font-semibold text-ink-900">{l.productName} {l.variantSize} ×{l.quantity}</p>
                {l.stockCountName && <p className="text-xs text-ink-500 mb-1">{l.stockCountName}</p>}
                <div role="group" aria-label={`Stok ${l.productName} ${l.variantSize}`} className="flex flex-wrap gap-2 mt-1">
                  <Chip selected={s.stockChoices[l.key] !== 'skip_counted'} onClick={() => setS(setStockChoice(s, l.key, 'restock'))}>{OPNAME_RESTOCK}</Chip>
                  <Chip selected={s.stockChoices[l.key] === 'skip_counted'} onClick={() => setS(setStockChoice(s, l.key, 'skip_counted'))}>{OPNAME_SKIP}</Chip>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <Banner tone="danger" message={error} className="rounded-control mb-3" />}

      <div className="flex items-stretch gap-2">
        <Button variant="secondary" size="lg" onClick={onClose} disabled={isProcessing} className="shrink-0">Batal</Button>
        <button type="button" disabled={!ready} onClick={() => { if (input && ready) onConfirm(input) }}
          className="bar-danger press-bar flex-1 min-h-16 rounded-control px-5 flex items-center justify-center font-bold disabled:opacity-40 disabled:pointer-events-none">
          {isProcessing ? 'Memproses…' : confirmLabel}
        </button>
      </div>
    </Sheet>
  )
}
