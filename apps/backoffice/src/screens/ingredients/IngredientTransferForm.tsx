import { useEffect, useMemo, useState } from 'react'
import type { Ingredient, Outlet, Warehouse, IngredientTransferCreateInput } from '@mandalika/api'
import { Save } from 'lucide-react'
import { api } from '../../api'
import { loadAllIngredients } from '../../lib/loadAll'
import { Button } from '../../ui/Button'
import { Field, Textarea, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface FormItem {
  rowId: number
  ingredientId: string
  qty: string
}

let nextRowId = 0
const makeRow = (): FormItem => ({ rowId: nextRowId++, ingredientId: '', qty: '' })

type LocKind = 'outlet' | 'warehouse'
interface LocPick {
  kind: LocKind
  id: string
}

interface IngredientTransferFormProps {
  onClose: () => void
  onCreated: () => void
}

const parse = (v: string): LocPick | null => {
  if (!v) return null
  const idx = v.indexOf(':')
  return { kind: v.slice(0, idx) as LocKind, id: v.slice(idx + 1) }
}

/** Create a draft ingredient transfer: pick source + dest (mesh: outlet or warehouse), then add items. */
export function IngredientTransferForm({ onClose, onCreated }: IngredientTransferFormProps) {
  const [loading, setLoading] = useState(true)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [source, setSource] = useState<LocPick | null>(null)
  const [dest, setDest] = useState<LocPick | null>(null)
  const [note, setNote] = useState('')
  const [items, setItems] = useState<FormItem[]>(() => [makeRow()])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      api.listOutlets(),
      api.listWarehouses(),
      loadAllIngredients((page, limit) => api.listIngredients({ page, limit })).then((r) => r.filter((i) => i.isActive)),
    ])
      .then(([outs, whs, ings]) => {
        setOutlets(outs)
        setWarehouses(whs.filter((w) => w.isActive))
        setIngredients(ings)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Gagal memuat data.'))
      .finally(() => setLoading(false))
  }, [])

  // Options as "kind:id" so a single <select> spans both warehouses + outlets.
  const options = useMemo(
    () => [
      ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
      ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
    ],
    [warehouses, outlets],
  )

  const setItem = (index: number, patch: Partial<FormItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))

  const addRow = () => setItems((prev) => [...prev, makeRow()])

  const removeRow = (index: number) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))

  const submit = async () => {
    if (!source) { setErr('Pilih sumber.'); return }
    if (!dest) { setErr('Pilih tujuan.'); return }
    if (source.kind === dest.kind && source.id === dest.id) {
      setErr('Sumber dan tujuan tidak boleh sama.')
      return
    }

    const validItems = items.filter((it) => it.ingredientId && it.qty.trim())
    if (validItems.length === 0) {
      setErr('Isi minimal satu baris dengan bahan dan qty > 0.')
      return
    }
    for (const it of validItems) {
      const qty = Number(it.qty)
      if (Number.isNaN(qty) || qty <= 0) {
        setErr('Qty harus angka > 0.')
        return
      }
    }

    setBusy(true)
    setErr(null)
    try {
      const body: IngredientTransferCreateInput = {
        source: { kind: source.kind, id: source.id },
        dest: { kind: dest.kind, id: dest.id },
        note: note.trim() || null,
        items: validItems.map((it) => ({
          ingredientId: it.ingredientId,
          qty: Number(it.qty),
        })),
      }
      await api.createIngredientTransfer(body)
      onClose()
      onCreated()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal membuat transfer.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Buat Transfer Bahan"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button
            className="flex-1"
            icon={<Save className="w-4 h-4" />}
            onClick={submit}
            loading={busy}
            disabled={loading}
          >
            {busy ? 'Menyimpan...' : 'Simpan Draft'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-gray-400">Memuat...</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Sumber *">
              <select
                value={source ? `${source.kind}:${source.id}` : ''}
                onChange={(e) => { setSource(parse(e.target.value)); setDest(null) }}
                className={fieldClass}
              >
                <option value="">Pilih sumber…</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Tujuan *">
              <select
                value={dest ? `${dest.kind}:${dest.id}` : ''}
                onChange={(e) => setDest(parse(e.target.value))}
                className={fieldClass}
                disabled={!source}
              >
                <option value="">Pilih tujuan…</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </div>

          <Textarea
            label="Catatan"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Opsional"
          />

          {/* Items grid */}
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-7 text-[11px] font-black text-gray-400 uppercase tracking-widest">
                Bahan
              </span>
              <span className="col-span-4 text-[11px] font-black text-gray-400 uppercase tracking-widest">
                Qty Kirim
              </span>
              <span className="col-span-1" />
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {items.map((it, idx) => (
                <div key={it.rowId} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={it.ingredientId}
                    onChange={(e) => setItem(idx, { ingredientId: e.target.value })}
                    className={`${fieldClass} col-span-7 py-1.5`}
                  >
                    <option value="">Pilih bahan...</option>
                    {ingredients.map((ing) => (
                      <option key={ing.id} value={ing.id}>
                        {ing.name} ({ing.unit})
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={it.qty}
                    onChange={(e) => setItem(idx, { qty: e.target.value })}
                    placeholder="0"
                    className={`${fieldClass} col-span-4 py-1.5`}
                    aria-label="Qty kirim"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    disabled={items.length === 1}
                    className="col-span-1 text-gray-400 hover:text-red-500 disabled:opacity-30 transition-colors text-lg font-bold leading-none"
                    title="Hapus baris"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addRow}
              className="mt-2 text-xs font-bold text-gold-700 hover:text-gold-800 transition-colors"
            >
              + Tambah baris
            </button>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </Modal>
  )
}
