import { useRef } from 'react'
import type { Category, ProductVariant } from '@mandalika/api'
import { X, Upload } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Field, Input, Select, Textarea } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { VariantRows } from './VariantRows'
import { OutletConfigSection } from './OutletConfigSection'
import { MAX_IMAGES } from './types'
import type { Form, OcRow, OcfgOutlet } from './types'

interface ProductFormModalProps {
  open: boolean
  onClose: () => void
  editing: boolean
  busy: boolean
  err: string | null
  onSave: () => void
  form: Form
  setForm: React.Dispatch<React.SetStateAction<Form>>
  categories: Category[]
  uploading: boolean
  onImage: (e: React.ChangeEvent<HTMLInputElement>) => void
  removeImage: (i: number) => void
  makeMainImage: (i: number) => void
  // variant wiring
  recipesEnabled: boolean
  recipeVariantIds: Set<string>
  onUpdVariant: (i: number, k: keyof ProductVariant, val: string) => void
  onAddVariant: () => void
  onRemoveVariant: (i: number) => void
  setRecipeFor: (r: { variantId: string; label: string }) => void
  // per-outlet wiring
  ocfgLoading: boolean
  ocfgOutlets: OcfgOutlet[]
  ocGet: (oid: string, size: string) => OcRow
  ocSet: (oid: string, size: string, patch: Partial<OcRow>) => void
  setOutletAllAvailable: (oid: string, available: boolean) => void
  basePriceOf: (size: string) => number
  ocCollapsed: Record<string, boolean>
  setOcCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}

// Disabled look for an ERP-owned control (the shared field class has none).
const ERP_LOCKED = 'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'

export function ProductFormModal({
  open, onClose, editing, busy, err, onSave,
  form, setForm, categories, uploading, onImage, removeImage, makeMainImage,
  recipesEnabled, recipeVariantIds, onUpdVariant, onAddVariant, onRemoveVariant, setRecipeFor,
  ocfgLoading, ocfgOutlets, ocGet, ocSet, setOutletAllAvailable, basePriceOf, ocCollapsed, setOcCollapsed,
}: ProductFormModalProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const erpLinked = form.erpLinked === true
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={editing ? 'Edit Produk' : 'Tambah Produk'}
      subtitle={erpLinked ? (
        <>
          Dari ERP{form.erpGroupKey && <span className="ml-1 font-mono text-[10px] text-gray-400">({form.erpGroupKey})</span>}
        </>
      ) : undefined}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button variant="primary" className="flex-1" loading={busy} onClick={onSave}>
            {editing ? 'Simpan' : 'Tambah'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label={`Foto Produk (maks ${MAX_IMAGES}, foto pertama = utama)`}>
          <div className="flex flex-wrap gap-2">
            {form.images.map((url, i) => (
              <div key={url} className="relative w-20 h-20 rounded-2xl overflow-hidden border border-gray-200 group">
                <img src={url} alt="" className="w-full h-full object-cover" />
                {i === 0 && (
                  <span className="absolute top-0 left-0 bg-gold-600 text-white text-[9px] font-bold px-1 rounded-br-lg">Utama</span>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1 transition">
                  {i !== 0 && (
                    <button type="button" onClick={() => makeMainImage(i)} title="Jadikan utama" className="text-white text-[10px] font-bold bg-gold-600 px-1.5 py-0.5 rounded">
                      Utama
                    </button>
                  )}
                  <button type="button" onClick={() => removeImage(i)} title="Hapus" className="text-white bg-red-600 rounded p-1">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
            {form.images.length < MAX_IMAGES && (
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="w-20 h-20 rounded-2xl border-2 border-dashed border-gray-200 flex flex-col items-center justify-center text-gray-400 hover:border-gold-400 hover:text-gold-600 disabled:opacity-50">
                {uploading ? (
                  <span className="text-[10px]">...</span>
                ) : (
                  <>
                    <Upload className="w-5 h-5" />
                    <span className="text-[10px] mt-0.5">Tambah</span>
                  </>
                )}
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={onImage} className="hidden" aria-label="Unggah foto produk" />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          {(['name', 'brand'] as const).map((k) => (
            <Input key={k} label={k === 'name' ? 'Nama Produk *' : 'Brand *'} type="text" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              disabled={erpLinked && k === 'name'} hint={erpLinked && k === 'name' ? <span id="erp-hint-name">Dikelola ERP</span> : undefined}
              aria-describedby={erpLinked && k === 'name' ? 'erp-hint-name' : undefined}
              className={erpLinked && k === 'name' ? ERP_LOCKED : undefined} />
          ))}
        </div>
        <Select label="Kategori *" value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
          disabled={erpLinked} hint={erpLinked ? <span id="erp-hint-category">Dikelola ERP</span> : undefined}
          aria-describedby={erpLinked ? 'erp-hint-category' : undefined} className={erpLinked ? ERP_LOCKED : undefined}>
          <option value="">Pilih kategori...</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Textarea label="Deskripsi" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        <div className="flex gap-4 flex-wrap">
          {(['isActive', 'isFeatured', 'sellable'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
              <span className="text-sm font-bold text-gray-700">{k === 'isActive' ? 'Produk Aktif' : k === 'isFeatured' ? 'Produk Unggulan' : 'Dijual ke pelanggan'}</span>
            </label>
          ))}
        </div>

        <VariantRows
          variants={form.variants}
          editing={editing}
          recipesEnabled={recipesEnabled}
          recipeVariantIds={recipeVariantIds}
          productName={form.name}
          onAddVariant={onAddVariant}
          onUpdVariant={onUpdVariant}
          onRemoveVariant={onRemoveVariant}
          setRecipeFor={setRecipeFor}
        />

        {editing && (
          <OutletConfigSection
            variants={form.variants}
            ocfgLoading={ocfgLoading}
            ocfgOutlets={ocfgOutlets}
            ocGet={ocGet}
            ocSet={ocSet}
            setOutletAllAvailable={setOutletAllAvailable}
            basePriceOf={basePriceOf}
            ocCollapsed={ocCollapsed}
            setOcCollapsed={setOcCollapsed}
          />
        )}

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  )
}
