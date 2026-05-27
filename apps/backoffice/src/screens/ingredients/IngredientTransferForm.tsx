import { useEffect, useState } from 'react'
import type { Ingredient, Warehouse, IngredientTransferCreateInput } from '@mandalika/api'
import { Save } from 'lucide-react'
import { api } from '../../api'
import { Button, Modal, Field, Textarea, fieldClass } from '../../ui'

interface FormItem {
  ingredientId: string
  qty: string
}

const EMPTY_ITEM: FormItem = { ingredientId: '', qty: '' }

interface IngredientTransferFormProps {
  onClose: () => void
  onCreated: () => void
}

/** Create a draft ingredient transfer: pick source + dest warehouses, then add items. */
export function IngredientTransferForm({ onClose, onCreated }: IngredientTransferFormProps) {
  const [loading, setLoading] = useState(true)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [sourceId, setSourceId] = useState('')
  const [destId, setDestId] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<FormItem[]>([{ ...EMPTY_ITEM }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      api.listWarehouses(),
      api.listIngredients({ limit: 200 }).then((r) => r.data.filter((i) => i.isActive)),
    ])
      .then(([whs, ings]) => {
        const active = whs.filter((w) => w.isActive)
        setWarehouses(active)
        setIngredients(ings)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Gagal memuat data.'))
      .finally(() => setLoading(false))
  }, [])

  const destOptions = warehouses.filter((w) => w.id !== sourceId)

  const setItem = (index: number, patch: Partial<FormItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))

  const addRow = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }])

  const removeRow = (index: number) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))

  const submit = async () => {
    if (!sourceId) { setErr('Pilih gudang sumber.'); return }
    if (!destId) { setErr('Pilih gudang tujuan.'); return }
    if (sourceId === destId) { setErr('Sumber dan tujuan tidak boleh sama.'); return }

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
        sourceWarehouseId: sourceId,
        destWarehouseId: destId,
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
            <Field label="Gudang Sumber *">
              <select
                value={sourceId}
                onChange={(e) => { setSourceId(e.target.value); setDestId('') }}
                className={fieldClass}
              >
                <option value="">Pilih gudang…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Gudang Tujuan *">
              <select
                value={destId}
                onChange={(e) => setDestId(e.target.value)}
                className={fieldClass}
                disabled={!sourceId}
              >
                <option value="">Pilih gudang…</option>
                {destOptions.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
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
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
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
