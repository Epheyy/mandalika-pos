import type { Product } from '@mandalika/api'
import { VariantPicker } from './VariantPicker'
import { MSG_DUPLICATE, lineKey, type RequisitionFormState } from './requisitionFlow'

interface Props {
  form: RequisitionFormState
  onChange: (next: RequisitionFormState) => void
  products: readonly Product[]
  busy: boolean
  /** A user-facing validation or server message; the form keeps its content. */
  message: string | null
  onMessage: (m: string | null) => void
  /** True when editing an existing draft (no "Simpan & Ajukan" needed to create). */
  isEdit: boolean
  onSave: (andSubmit: boolean) => void
  onDiscard: () => void
}

export function RequisitionForm({ form, onChange, products, busy, message, onMessage, isEdit, onSave, onDiscard }: Props) {
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
    <div className="p-4 space-y-4">
      <VariantPicker products={products} taken={taken} onPick={add} />

      <div>
        <div className="text-xs font-bold text-gray-400 mb-1">Barang diminta</div>
        {form.lines.length === 0 && <p className="text-sm text-gray-400">Belum ada barang.</p>}
        {form.lines.map((l, i) => (
          <div key={lineKey(l)} className="flex items-center gap-2 py-1.5 border-b">
            <span className="flex-1 text-sm text-gray-800">{l.productName} · {l.variantSize}{l.sku ? ` (${l.sku})` : ''}</span>
            <input
              type="number" inputMode="numeric" min={1} step={1} value={l.qty} aria-label={`Qty ${l.productName} ${l.variantSize}`}
              onChange={(e) => setQty(i, e.target.value)} className="w-20 border rounded-lg px-2 py-1 text-sm text-right"
            />
            <button type="button" onClick={() => remove(i)} aria-label="Hapus baris" className="text-gray-400 text-xl leading-none px-1">×</button>
          </div>
        ))}
      </div>

      <label className="block text-sm">
        <span className="text-xs font-bold text-gray-500">Dibutuhkan pada (opsional)</span>
        <input type="date" value={form.neededBy} onChange={(e) => onChange({ ...form, neededBy: e.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2" />
      </label>
      <label className="block text-sm">
        <span className="text-xs font-bold text-gray-500">Diminta oleh (opsional)</span>
        <input value={form.requestedBy} onChange={(e) => onChange({ ...form, requestedBy: e.target.value })} placeholder="Nama peminta" className="mt-1 w-full border rounded-lg px-3 py-2" />
      </label>
      <label className="block text-sm">
        <span className="text-xs font-bold text-gray-500">Catatan (opsional)</span>
        <textarea value={form.note} onChange={(e) => onChange({ ...form, note: e.target.value })} rows={2} className="mt-1 w-full border rounded-lg px-3 py-2" />
      </label>

      {message && <p className="text-sm text-red-600">{message}</p>}

      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onSave(false)} className="flex-1 border rounded-lg py-2.5 text-sm font-bold text-gray-700 disabled:opacity-50">Simpan Draf</button>
        <button type="button" disabled={busy} onClick={() => onSave(true)} className="flex-1 bg-indigo-600 text-white rounded-lg py-2.5 text-sm font-bold disabled:opacity-50">Simpan &amp; Ajukan</button>
      </div>
      {!isEdit && form.lines.length > 0 && (
        <button type="button" disabled={busy} onClick={onDiscard} className="w-full text-xs text-gray-400">Buang isian</button>
      )}
    </div>
  )
}
