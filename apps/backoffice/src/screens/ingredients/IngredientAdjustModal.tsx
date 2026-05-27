import { useEffect, useState } from 'react'
import type { Ingredient, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, Field, fieldClass } from '../../ui'

interface IngredientAdjustModalProps {
  onClose: () => void
  /** Called after successful adjust so the parent can react. */
  onDone: () => void | Promise<void>
}

/** Penyesuaian Stok: sets absolute on-hand qty for a single ingredient. */
export function IngredientAdjustModal({ onClose, onDone }: IngredientAdjustModalProps) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [warehouseId, setWarehouseId] = useState('')
  const [ingredientId, setIngredientId] = useState('')
  const [newQty, setNewQty] = useState('')
  const [reason, setReason] = useState('')
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

  const qty = Number(newQty)
  const valid =
    warehouseId !== '' &&
    ingredientId !== '' &&
    newQty.trim() !== '' &&
    !Number.isNaN(qty) &&
    qty >= 0 &&
    reason.trim() !== ''

  const submit = async () => {
    if (!warehouseId) { setErr('Pilih gudang.'); return }
    if (!ingredientId) { setErr('Pilih bahan.'); return }
    if (newQty.trim() === '' || Number.isNaN(qty) || qty < 0) {
      setErr('Qty baru wajib diisi (≥ 0).')
      return
    }
    if (!reason.trim()) { setErr('Alasan penyesuaian wajib diisi.'); return }

    setBusy(true)
    setErr(null)
    try {
      await api.adjustIngredientStock({
        warehouseId,
        ingredientId,
        newQty: qty,
        reason: reason.trim(),
      })
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyesuaikan stok.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Penyesuaian Stok Bahan"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!valid || loading}>
            {busy ? 'Menyimpan...' : 'Simpan Penyesuaian'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-gray-400">Memuat...</p>
      ) : (
        <div className="space-y-4">
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

          <Field label="Bahan *">
            <select
              value={ingredientId}
              onChange={(e) => setIngredientId(e.target.value)}
              className={fieldClass}
            >
              <option value="">Pilih bahan...</option>
              {ingredients.map((ing) => (
                <option key={ing.id} value={ing.id}>
                  {ing.name} ({ing.unit})
                </option>
              ))}
            </select>
          </Field>

          <Input
            label="Qty Baru *"
            type="number"
            min={0}
            value={newQty}
            onChange={(e) => setNewQty(e.target.value)}
            placeholder="0"
            hint="Stok akan diset ke nilai ini (absolut, bukan penambahan)."
          />

          <Input
            label="Alasan *"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="mis. opname, rusak, koreksi input"
          />

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </Modal>
  )
}
