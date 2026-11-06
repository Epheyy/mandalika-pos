import type { Product } from '@mandalika/api'
import { VariantPicker } from './VariantPicker'
import { Button } from '../../components/ui/Button'
import { MAX_NOTE, MAX_REQUESTED_BY, MSG_DUPLICATE, lineKey, type RequisitionFormState } from './requisitionFlow'

interface Props {
  form: RequisitionFormState
  onChange: (next: RequisitionFormState) => void
  products: readonly Product[]
  busy: boolean
  /** A user-facing validation or server message; the form keeps its content. */
  message: string | null
  onMessage: (m: string | null) => void
  /** Set when the last failure was "server belum menjawab": re-sends the same save (same key). */
  onRetry?: (() => void) | null
  /** Set when a pending create is stuck on a permanent cause: offers a forced discard without any check. */
  onForceDiscard?: (() => void) | null
  /** True when editing an existing draft (no "Simpan & Ajukan" needed to create). */
  isEdit: boolean
  onSave: (andSubmit: boolean) => void
  onDiscard: () => void
}

export function RequisitionForm({ form, onChange, products, busy, message, onMessage, onRetry, onForceDiscard, isEdit, onSave, onDiscard }: Props) {
  const taken = new Set(form.lines.map(lineKey))
  const add = (o: { productId: string; productName: string; variantSize: string; sku: string }) => {
    if (taken.has(lineKey(o))) { onMessage(MSG_DUPLICATE); return }
    onMessage(null)
    onChange({ ...form, lines: [...form.lines, { ...o, qty: '1' }] })
  }
  const setQty = (i: number, qty: string) =>
    onChange({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, qty } : l)) })
  const remove = (i: number) => onChange({ ...form, lines: form.lines.filter((_, j) => j !== i) })

  return (
    // While a request is in flight nothing can be edited: an edit would change the content under a pending key.
    <fieldset disabled={busy} className="p-4 space-y-4 border-0 m-0 min-w-0">
      <VariantPicker products={products} taken={taken} onPick={add} />

      <div>
        <div className="text-xs font-bold text-ink-500 mb-1">Barang diminta</div>
        {form.lines.length === 0 && <p className="text-sm text-ink-500">Belum ada barang.</p>}
        {form.lines.map((l, i) => (
          <div key={lineKey(l)} className="flex items-center gap-2 py-1.5 border-b border-paper-2">
            <span className="flex-1 text-sm text-ink-900">{l.productName} · {l.variantSize}{l.sku ? ` (${l.sku})` : ''}</span>
            <input
              type="number" inputMode="numeric" min={1} step={1} value={l.qty} aria-label={`Qty ${l.productName} ${l.variantSize}`}
              onChange={(e) => setQty(i, e.target.value)} className="tnum w-20 min-h-11 border border-paper-2 bg-white rounded-control px-2 py-1 text-sm text-right text-ink-900 focus:outline-none focus:border-ink-700"
            />
            <button type="button" onClick={() => remove(i)} aria-label="Hapus baris" className="press inline-flex h-11 w-11 items-center justify-center rounded-control text-xl leading-none text-ink-700 active:bg-paper-1">×</button>
          </div>
        ))}
      </div>

      <label className="block text-sm">
        <span className="text-xs font-bold text-ink-700">Dibutuhkan pada (opsional)</span>
        <input type="date" value={form.neededBy} onChange={(e) => onChange({ ...form, neededBy: e.target.value })} className="mt-1 w-full min-h-11 border border-paper-2 bg-white rounded-control px-3 py-2 text-ink-900 focus:outline-none focus:border-ink-700" />
      </label>
      <label className="block text-sm">
        <span className="text-xs font-bold text-ink-700">Diminta oleh (opsional)</span>
        <input value={form.requestedBy} maxLength={MAX_REQUESTED_BY} onChange={(e) => onChange({ ...form, requestedBy: e.target.value })} placeholder="Nama peminta" className="mt-1 w-full min-h-11 border border-paper-2 bg-white rounded-control px-3 py-2 text-ink-900 focus:outline-none focus:border-ink-700" />
      </label>
      <label className="block text-sm">
        <span className="text-xs font-bold text-ink-700">Catatan (opsional)</span>
        <textarea value={form.note} maxLength={MAX_NOTE} onChange={(e) => onChange({ ...form, note: e.target.value })} rows={2} className="mt-1 w-full min-h-11 border border-paper-2 bg-white rounded-control px-3 py-2 text-ink-900 focus:outline-none focus:border-ink-700" />
      </label>

      {message && <p className="text-sm text-danger">{message}</p>}
      {message && onRetry && (
        <Button variant="secondary" fullWidth onClick={onRetry}>Coba Lagi</Button>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => onSave(false)} className="flex-1">Simpan Draf</Button>
        <Button disabled={busy} onClick={() => onSave(true)} className="flex-1">Simpan &amp; Ajukan</Button>
      </div>
      {onForceDiscard && (
        <Button variant="ghost" disabled={busy} onClick={onForceDiscard} fullWidth className="!text-danger text-xs">Buang tanpa cek — periksa daftar permintaan dulu</Button>
      )}
      {!isEdit && form.lines.length > 0 && (
        <Button variant="ghost" disabled={busy} onClick={onDiscard} fullWidth className="text-xs text-ink-700">Buang isian</Button>
      )}
    </fieldset>
  )
}
