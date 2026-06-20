import { useEffect, useState } from 'react'
import type { Ingredient, Outlet, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { Button } from '../../ui/Button'
import { Input, Field, fieldClass } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface GoodsInItem {
  ingredientId: string
  qty: string
  unitCost: string
}

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

interface IngredientGoodsInModalProps {
  onClose: () => void
  /** Called after successful submit so the parent can react (e.g. switch tab). */
  onDone: () => void | Promise<void>
  /** Pre-selected location — when omitted the user picks from a list. */
  location?: LocationTarget
}

const EMPTY_ITEM: GoodsInItem = { ingredientId: '', qty: '', unitCost: '' }

/** Stok Masuk Bahan: records a goods receipt for one or more ingredients. */
export function IngredientGoodsInModal({ onClose, onDone, location: propLocation }: IngredientGoodsInModalProps) {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [locationKey, setLocationKey] = useState(
    propLocation ? `${propLocation.kind}:${propLocation.id}` : '',
  )
  const [supplier, setSupplier] = useState('')
  const [note, setNote] = useState('')
  const [items, setItems] = useState<GoodsInItem[]>([{ ...EMPTY_ITEM }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const tasks: Promise<unknown>[] = [
      api.listIngredients({ limit: 200 }).then((r) => setIngredients(r.data.filter((i) => i.isActive))),
    ]
    if (!propLocation) {
      tasks.push(
        api.listOutlets().then(setOutlets),
        api.listWarehouses().then((whs) => setWarehouses(whs.filter((w) => w.isActive))),
      )
    }
    Promise.all(tasks)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Gagal memuat data.'))
      .finally(() => setLoading(false))
  }, [propLocation])

  // All location options encoded as "kind:id"
  const locationOptions = [
    ...warehouses.map((w) => ({ value: `warehouse:${w.id}`, label: `Gudang · ${w.name}` })),
    ...outlets.map((o) => ({ value: `outlet:${o.id}`, label: `Outlet · ${o.name}` })),
  ]

  const parseLocation = (key: string): LocationTarget | null => {
    if (!key) return null
    const idx = key.indexOf(':')
    const kind = key.slice(0, idx) as 'outlet' | 'warehouse'
    const id = key.slice(idx + 1)
    const found =
      kind === 'outlet'
        ? outlets.find((o) => o.id === id)
        : warehouses.find((w) => w.id === id)
    return found ? { kind, id, name: found.name } : { kind, id, name: id }
  }

  const resolvedLocation = propLocation ?? parseLocation(locationKey)

  const setItem = (index: number, patch: Partial<GoodsInItem>) =>
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    )

  const addRow = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }])

  const removeRow = (index: number) =>
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))

  const submit = async () => {
    if (!resolvedLocation) { setErr('Pilih lokasi.'); return }

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
      await api.createIngredientLocationGoodsReceipt(
        { kind: resolvedLocation.kind, id: resolvedLocation.id },
        {
          supplier: supplier.trim() || null,
          note: note.trim() || null,
          items: validItems.map((it) => ({
            ingredientId: it.ingredientId,
            qty: Number(it.qty),
            unitCost: it.unitCost.trim() ? Number(it.unitCost) : null,
          })),
        },
      )
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal mencatat stok masuk.')
    } finally {
      setBusy(false)
    }
  }

  const titleSuffix = propLocation ? ` — ${propLocation.name}` : ''

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Stok Masuk Bahan${titleSuffix}`}
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
          {/* Location picker (shown only when not pre-selected) */}
          {!propLocation && (
            <Field label="Lokasi *">
              <select
                value={locationKey}
                onChange={(e) => setLocationKey(e.target.value)}
                className={fieldClass}
              >
                <option value="">Pilih lokasi...</option>
                {locationOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* Meta */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Pemasok"
              type="text"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="Opsional"
            />
            <Input
              label="Catatan"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Opsional"
            />
          </div>

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
                    aria-label="Qty"
                  />
                  <input
                    type="number"
                    min={0}
                    value={it.unitCost}
                    onChange={(e) => setItem(idx, { unitCost: e.target.value })}
                    placeholder="—"
                    className={`${fieldClass} col-span-3 py-1.5`}
                    aria-label="Biaya per satuan"
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
