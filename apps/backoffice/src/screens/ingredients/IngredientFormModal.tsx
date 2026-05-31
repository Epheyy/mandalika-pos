import { useEffect, useState } from 'react'
import type { Ingredient, IngredientCategory } from '@mandalika/api'
import { api } from '../../api'
import { Button, Modal, Input, Select, Textarea, Field, fieldClass } from '../../ui'
import { COMMON_UNITS, isCommonUnit } from './units'
import { CategoryManager } from './CategoryManager'

interface IngredientFormModalProps {
  /** When provided, the modal is in edit mode. */
  editing: Ingredient | null
  onClose: () => void
  /** Called after a successful create or update so the parent can refetch. */
  onDone: () => void | Promise<void>
}

/** Derive the UOM select value from a raw unit string. */
function toSelectUnit(unit: string): string {
  return isCommonUnit(unit) ? unit : 'Lainnya'
}

/** Create / edit a single ingredient. */
export function IngredientFormModal({ editing, onClose, onDone }: IngredientFormModalProps) {
  const initialUnit = editing?.unit ?? ''
  const [form, setForm] = useState({
    name: editing?.name ?? '',
    /** The value shown in the UOM <select>: one of COMMON_UNITS or 'Lainnya'. */
    unitSelect: initialUnit === '' ? '' : toSelectUnit(initialUnit),
    /** Free-text when unitSelect === 'Lainnya'. */
    unitCustom: isCommonUnit(initialUnit) || initialUnit === '' ? '' : initialUnit,
    sku: editing?.sku ?? '',
    categoryId: editing?.categoryId ?? '',
    defaultUnitCost: editing?.defaultUnitCost != null ? String(editing.defaultUnitCost) : '',
    notes: editing?.notes ?? '',
    isActive: editing != null ? editing.isActive : true,
  })

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Category dropdown state
  const [categories, setCategories] = useState<IngredientCategory[]>([])
  const [catsLoading, setCatsLoading] = useState(true)

  // Inline "add new category" state
  const [showNewCat, setShowNewCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatBusy, setNewCatBusy] = useState(false)
  const [newCatErr, setNewCatErr] = useState<string | null>(null)

  // Manage-categories panel (delete affordance)
  const [showManageCats, setShowManageCats] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .listIngredientCategories()
      .then((cats) => { if (alive) setCategories(cats) })
      .catch(() => { /* non-fatal; dropdown stays empty */ })
      .finally(() => { if (alive) setCatsLoading(false) })
    return () => { alive = false }
  }, [])

  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  /** The actual `unit` value to send to the API. */
  const resolvedUnit =
    form.unitSelect === 'Lainnya' ? form.unitCustom.trim() : form.unitSelect

  const valid =
    form.name.trim() !== '' &&
    resolvedUnit !== ''

  const handleAddCategory = async () => {
    if (!newCatName.trim()) return
    setNewCatBusy(true)
    setNewCatErr(null)
    try {
      await api.createIngredientCategory({ name: newCatName.trim() })
      const updated = await api.listIngredientCategories()
      setCategories(updated)
      // Auto-select the newly created category
      const created = updated.find((c) => c.name === newCatName.trim())
      if (created) setField('categoryId', created.id)
      setNewCatName('')
      setShowNewCat(false)
    } catch (e: unknown) {
      setNewCatErr(e instanceof Error ? e.message : 'Gagal menambah kategori.')
    } finally {
      setNewCatBusy(false)
    }
  }

  const submit = async () => {
    if (!form.name.trim()) { setErr('Nama bahan wajib diisi.'); return }
    if (!resolvedUnit) { setErr('Satuan wajib diisi.'); return }

    const cost = form.defaultUnitCost.trim() ? Number(form.defaultUnitCost) : null
    if (form.defaultUnitCost.trim() && (Number.isNaN(cost) || (cost ?? 0) < 0)) {
      setErr('Biaya default harus angka ≥ 0.')
      return
    }

    const input = {
      name: form.name.trim(),
      unit: resolvedUnit,
      sku: form.sku.trim() || null,
      categoryId: form.categoryId || null,
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
          label="SKU"
          type="text"
          value={form.sku}
          onChange={(e) => setField('sku', e.target.value)}
          placeholder="Opsional, contoh: RO-001"
        />

        {/* Category dropdown */}
        <div>
          <Select
            label="Kategori"
            value={form.categoryId}
            onChange={(e) => setField('categoryId', e.target.value)}
            disabled={catsLoading}
          >
            <option value="">— Tanpa kategori —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>

          {/* Action row: add new + manage (delete) */}
          {!showNewCat && (
            <div className="mt-1 flex items-center gap-3">
              <button
                type="button"
                onClick={() => { setShowNewCat(true); setShowManageCats(false) }}
                className="text-xs text-gold-600 hover:text-gold-700 font-medium"
              >
                + Tambah kategori baru
              </button>
              {categories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowManageCats((v) => !v)}
                  className="text-xs text-gray-400 hover:text-gray-600 font-medium"
                >
                  {showManageCats ? 'Tutup kelola' : 'Kelola kategori'}
                </button>
              )}
            </div>
          )}

          {/* Inline add-category form */}
          {showNewCat && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="Nama kategori baru"
                className={fieldClass + ' flex-1'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleAddCategory() }
                  if (e.key === 'Escape') setShowNewCat(false)
                }}
                autoFocus
              />
              <Button
                onClick={() => { void handleAddCategory() }}
                loading={newCatBusy}
                disabled={!newCatName.trim()}
                className="shrink-0"
              >
                Simpan
              </Button>
              <Button
                variant="secondary"
                onClick={() => { setShowNewCat(false); setNewCatName(''); setNewCatErr(null) }}
                className="shrink-0"
              >
                Batal
              </Button>
            </div>
          )}
          {newCatErr && (
            <p className="text-[11px] text-red-600 mt-1">{newCatErr}</p>
          )}

          {/* Manage (delete) panel */}
          {showManageCats && !showNewCat && (
            <CategoryManager
              categories={categories}
              selectedCategoryId={form.categoryId}
              onCategoriesChange={setCategories}
              onCategoryDeleted={() => setField('categoryId', '')}
            />
          )}
        </div>

        {/* UOM control */}
        <div>
          <Select
            label="Satuan *"
            value={form.unitSelect}
            onChange={(e) => {
              setField('unitSelect', e.target.value)
              // Clear custom when switching back to a standard unit
              if (e.target.value !== 'Lainnya') setField('unitCustom', '')
            }}
          >
            <option value="">— Pilih satuan —</option>
            {COMMON_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            <option value="Lainnya">Lainnya…</option>
          </Select>

          {form.unitSelect === 'Lainnya' && (
            <div className="mt-2">
              <Input
                label="Satuan kustom *"
                type="text"
                value={form.unitCustom}
                onChange={(e) => setField('unitCustom', e.target.value)}
                placeholder="Tulis satuan, mis. sachet"
                autoFocus
              />
            </div>
          )}
        </div>

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
