import { useState } from 'react'
import type { Ingredient } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, Textarea, Field } from '../../ui'

interface IngredientFormModalProps {
  /** When provided, the modal is in edit mode. */
  editing: Ingredient | null
  onClose: () => void
  /** Called after a successful create or update so the parent can refetch. */
  onDone: () => void | Promise<void>
}

/** Create / edit a single ingredient. */
export function IngredientFormModal({ editing, onClose, onDone }: IngredientFormModalProps) {
  const [form, setForm] = useState({
    name: editing?.name ?? '',
    unit: editing?.unit ?? '',
    defaultUnitCost: editing?.defaultUnitCost != null ? String(editing.defaultUnitCost) : '',
    notes: editing?.notes ?? '',
    isActive: editing != null ? editing.isActive : true,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const valid = form.name.trim() !== '' && form.unit.trim() !== ''

  const submit = async () => {
    if (!form.name.trim()) { setErr('Nama bahan wajib diisi.'); return }
    if (!form.unit.trim()) { setErr('Satuan wajib diisi.'); return }

    const cost = form.defaultUnitCost.trim() ? Number(form.defaultUnitCost) : null
    if (form.defaultUnitCost.trim() && (Number.isNaN(cost) || (cost ?? 0) < 0)) {
      setErr('Biaya default harus angka ≥ 0.')
      return
    }

    const input = {
      name: form.name.trim(),
      unit: form.unit.trim(),
      defaultUnitCost: cost,
      notes: form.notes.trim() || null,
      isActive: form.isActive,
    }

    setBusy(true)
    setErr(null)
    try {
      if (editing) {
        await api.updateIngredient(editing.id, input)
      } else {
        await api.createIngredient(input)
      }
      onClose()
      await onDone()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan bahan.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={editing ? 'Edit Bahan' : 'Tambah Bahan'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Batal
          </Button>
          <Button className="flex-1" onClick={submit} loading={busy} disabled={!valid}>
            {busy ? 'Menyimpan...' : editing ? 'Simpan Perubahan' : 'Tambah Bahan'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Nama Bahan *"
          type="text"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="mis. Tepung Terigu"
          autoFocus
        />
        <Input
          label="Satuan *"
          type="text"
          value={form.unit}
          onChange={(e) => setField('unit', e.target.value)}
          placeholder="g / ml / L / kg / drop / pcs"
        />
        <Input
          label="Biaya Default / Satuan"
          type="number"
          min={0}
          value={form.defaultUnitCost}
          onChange={(e) => setField('defaultUnitCost', e.target.value)}
          placeholder="Opsional"
        />
        <Textarea
          label="Catatan"
          value={form.notes}
          onChange={(e) => setField('notes', e.target.value)}
          placeholder="Opsional"
          rows={2}
        />
        <Field label="Status">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setField('isActive', e.target.checked)}
              className="w-4 h-4 rounded accent-gold-600"
            />
            <span className="text-sm text-gray-700">Aktif</span>
          </label>
        </Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
