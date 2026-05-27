import { useEffect, useState } from 'react'
import type { Ingredient, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, Field, fieldClass } from '../../ui'

interface GoodsInItem {
  ingredientId: string
  qty: string
  unitCost: string
}

interface IngredientGoodsInModalProps {
  onClose: () => void
  /** Called after successful submit so the parent can react (e.g. switch tab). */
  onDone: () => void | Promise<void>
}

const EMPTY_ITEM: GoodsInItem = { ingredientId: '', qty: '', unitCost: '' }

/** Stok Masuk Bahan: records a goods receipt for one or more ingredients. */
export function IngredientGoodsInModal({ onClose, onDone }: IngredientGoodsInModalProps) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [warehouseId, setWarehouseId] = useState('')
  const [supplier, setSupplier] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<GoodsInItem[]>([{ ...EMPTY_ITEM }])
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
        if (active.length > 0) setWarehouseId(active[0].id)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Gagal memuat data.'))
      .finally(() => setLoading(false))
  }, [])

  const setItem = (index: number, patch: Partial<GoodsInItem>) =>
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    )

  const addRow = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }])

  const removeRow = (index: number) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))

  const submit = async () => {
    if (!warehouseId) { setErr('Pilih gudang.'); return }

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
      await api.createIngredientGoodsReceipt({
        warehouseId,
        supplier: supplier.trim() || null,
        note: note.trim() || null,
        items: validItems.map((it) => ({
          ingredientId: it.ingredientId,
          qty: Number(it.qty),
          unitCost: it.unitCost.trim() ? Number(it.unitCost) : null,
        })),
      })
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal mencatat stok masuk.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Stok Masuk Bahan"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={loading}>
            {busy ? 'Menyimpan...' : 'Catat Stok Masuk'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-gray-400">Memuat...</p>
      ) : (
        <div className="space-y-4">
          {/* Warehouse + meta */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Gudang *">
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={fieldClass}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Input
              label="Pemasok"
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="Opsional"
            />
          </div>
          <Input
            label="Catatan"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Opsional"
          />

          {/* Items grid */}
          <div>
            <div className="grid grid-cols-12 gap-2 px-1 mb-1">
              <span className="col-span-5 text-[11px] font-black text-gray-400 uppercase tracking-widest">
                Bahan
              </span>
              <span className="col-span-3 text-[11px] font-black text-gray-400 uppercase tracking-widest">
                Qty
              </span>
              <span className="col-span-3 text-[11px] font-black text-gray-400 uppercase tracking-widest">
                Biaya/Satuan
              </span>
              <span className="col-span-1" />
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={it.ingredientId}
                    onChange={(e) => setItem(idx, { ingredientId: e.target.value })}
                    className={`${fieldClass} col-span-5 py-1.5`}
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
                    value={it.qty}
                    onChange={(e) => setItem(idx, { qty: e.target.value })}
                    placeholder="0"
                    className={`${fieldClass} col-span-3 py-1.5`}
                  />
                  <input
                    type="number"
                    min={0}
                    value={it.unitCost}
                    onChange={(e) => setItem(idx, { unitCost: e.target.value })}
                    placeholder="—"
                    className={`${fieldClass} col-span-3 py-1.5`}
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
            <p className="text-[11px] text-gray-400 mt-1">
              Biaya/satuan opsional (informasi). Hanya baris dengan qty &gt; 0 yang dicatat.
            </p>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </Modal>
  )
}
