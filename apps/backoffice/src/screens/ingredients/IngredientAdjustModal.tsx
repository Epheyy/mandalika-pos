import { useEffect, useState } from 'react'
import type { Ingredient, Outlet, Warehouse } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, Field, fieldClass } from '../../ui'

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

interface IngredientAdjustModalProps {
  onClose: () => void
  /** Called after successful adjust so the parent can react. */
  onDone: () => void | Promise<void>
  /** Pre-selected location — when omitted the user picks from a list. */
  location?: LocationTarget
  /** Pre-selected ingredient id — when set the picker is hidden. */
  ingredientId?: string
}

/** Penyesuaian Stok: sets absolute on-hand qty for a single ingredient. */
export function IngredientAdjustModal({
  onClose,
  onDone,
  location: propLocation,
  ingredientId: propIngredientId,
}: IngredientAdjustModalProps) {
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  // "kind:id" encoded value for the location picker
  const [locationKey, setLocationKey] = useState(
    propLocation ? `${propLocation.kind}:${propLocation.id}` : '',
  )
  const [ingredientId, setIngredientId] = useState(propIngredientId ?? '')
  const [newQty, setNewQty] = useState('')
  const [reason, setReason] = useState('')
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
    if (propLocation) return propLocation
    const found =
      kind === 'outlet'
        ? outlets.find((o) => o.id === id)
        : warehouses.find((w) => w.id === id)
    return found ? { kind, id, name: found.name } : { kind, id, name: id }
  }

  const qty = Number(newQty)
  const resolvedLocation = propLocation ?? parseLocation(locationKey)
  const valid =
    resolvedLocation != null &&
    ingredientId !== '' &&
    newQty.trim() !== '' &&
    !Number.isNaN(qty) &&
    qty >= 0 &&
    reason.trim() !== ''

  const submit = async () => {
    if (!resolvedLocation) { setErr('Pilih lokasi.'); return }
    if (!ingredientId) { setErr('Pilih bahan.'); return }
    if (newQty.trim() === '' || Number.isNaN(qty) || qty < 0) {
      setErr('Qty baru wajib diisi (≥ 0).')
      return
    }
    if (!reason.trim()) { setErr('Alasan penyesuaian wajib diisi.'); return }

    setBusy(true)
    setErr(null)
    try {
      await api.adjustIngredientLocationStock(
        { kind: resolvedLocation.kind, id: resolvedLocation.id },
        { ingredientId, newQty: qty, reason: reason.trim() },
      )
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyesuaikan stok.')
    } finally {
      setBusy(false)
    }
  }

  const titleSuffix = propLocation ? ` — ${propLocation.name}` : ''

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Penyesuaian Stok Bahan${titleSuffix}`}
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

          {!propIngredientId && (
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
          )}

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
