import { useRef } from 'react'
import type { Category, ProductVariant } from '@mandalika/api'
import { X, Upload } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Field, Input, Select, Textarea } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { Switch } from '../../ui/Switch'
import { VariantRows } from './VariantRows'
import { OutletConfigSection } from './OutletConfigSection'
import { MAX_IMAGES } from './types'
import type { Form, OcRow, OcfgOutlet } from './types'
import type { EditorLoad } from './useProductEditor'
import { FIELD_ID, type ProductFormError } from './validateForm'

interface ProductFormSlideOverProps {
  /** Closes the editor; the caller asks about unsaved changes first (dirty is shown, not guarded, here). */
  onClose: () => void
  editing: boolean
  load: EditorLoad
  loadError: string | null
  dirty: boolean
  busy: boolean
  /** A refused save (server message). */
  err: string | null
  /** Field problems after a save attempt; empty until then. */
  errors: readonly ProductFormError[]
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

export function ProductFormSlideOver({
  onClose, editing, load, loadError, dirty, busy, err, errors, onSave,
  form, setForm, categories, uploading, onImage, removeImage, makeMainImage,
  recipesEnabled, recipeVariantIds, onUpdVariant, onAddVariant, onRemoveVariant, setRecipeFor,
  ocfgLoading, ocfgOutlets, ocGet, ocSet, setOutletAllAvailable, basePriceOf, ocCollapsed, setOcCollapsed,
}: ProductFormSlideOverProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const erpLinked = form.erpLinked === true
  const ready = load === 'ready'
  const byField: Record<string, string> = Object.fromEntries(errors.map((e) => [e.fieldId, e.message]))
  return (
    <SlideOver
      open
      onClose={onClose}
      width="lg"
      // Unsaved changes are guarded by the screen (one question for ×, Escape, Back and the sidebar), not by the panel.
      dirty={false}
      title={editing ? 'Ubah produk' : 'Tambah produk'}
      subtitle={erpLinked ? (
        <>
          {editing && form.name.trim() && <>{form.name.trim()} · </>}Dari ERP{form.erpGroupKey && <span className="ml-1 font-mono text-[10px] text-ink-700">({form.erpGroupKey})</span>}
        </>
      ) : (editing && form.name.trim() ? form.name.trim() : undefined)}
      errorSummary={errors.map((e) => ({ fieldId: e.fieldId, label: e.label }))}
      footer={
        <SlideOver.Footer dirty={dirty}>
          <Button variant="secondary" onClick={onClose}>{ready ? 'Batal' : 'Tutup'}</Button>
          {ready && (
            <Button variant="primary" loading={busy} onClick={onSave}>
              {editing ? 'Simpan perubahan' : 'Tambah produk'}
            </Button>
          )}
        </SlideOver.Footer>
      }
    >
      {load === 'loading' && <p className="text-sm text-ink-700">Memuat produk…</p>}
      {(load === 'missing' || load === 'failed') && <p role="alert" className="text-sm text-danger">{loadError}</p>}
      {ready && (
        <div className="space-y-5">
          <Field label={`Foto Produk (maks ${MAX_IMAGES}, foto pertama = utama)`}>
            <div className="flex flex-wrap gap-2">
              {form.images.map((url, i) => (
                <div key={url} className="relative w-20 h-20 rounded-2xl overflow-hidden border border-paper-2 group">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  {i === 0 && (
                    <span className="absolute top-0 left-0 bg-brand-strong text-on-brand text-[9px] font-bold px-1 rounded-br-lg">Utama</span>
                  )}
                  <div className="absolute inset-0 bg-ink-900/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center justify-center gap-1 transition">
                    {i !== 0 && (
                      <button type="button" onClick={() => makeMainImage(i)} title="Jadikan utama" className="text-on-brand text-[10px] font-bold bg-brand-strong px-1.5 py-0.5 rounded">
                        Utama
                      </button>
                    )}
                    <button type="button" onClick={() => removeImage(i)} title="Hapus" aria-label="Hapus foto" className="text-on-brand bg-danger-solid rounded p-1">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
              {form.images.length < MAX_IMAGES && (
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="w-20 h-20 rounded-2xl border-2 border-dashed border-paper-2 flex flex-col items-center justify-center text-ink-700 hover:border-brand-strong hover:text-brand-strong disabled:opacity-50">
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
            <Input id={FIELD_ID.name} label="Nama Produk *" type="text" value={form.name} error={byField[FIELD_ID.name]} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Input id="product-brand" label="Merek *" type="text" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} />
          </div>
          <Select id={FIELD_ID.category} label="Kategori *" value={form.categoryId} error={byField[FIELD_ID.category]} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}>
            <option value="">Pilih kategori...</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Textarea label="Deskripsi" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
          <div className="flex items-center justify-between gap-4 rounded-xl border border-paper-2 px-4 py-3">
            <div>
              <p aria-hidden="true" className="text-sm font-bold text-ink-900">Aktif</p>
              <p className="text-xs text-ink-700">Tampil di POS saat tablet sinkron berikutnya</p>
            </div>
            <Switch checked={form.isActive} onChange={(isActive) => setForm((f) => ({ ...f, isActive }))} label="Produk Aktif" />
          </div>
          <div className="flex gap-6 flex-wrap items-center">
            {(['isFeatured', 'sellable'] as const).map((k) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} className="w-4 h-4 accent-brand-strong" />
                <span className="text-sm font-bold text-ink-700">{k === 'isFeatured' ? 'Produk Unggulan' : 'Dijual ke pelanggan'}</span>
              </label>
            ))}
          </div>

          <VariantRows
            variants={form.variants}
            editing={editing}
            recipesEnabled={recipesEnabled}
            recipeVariantIds={recipeVariantIds}
            productName={form.name}
            errors={byField}
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

          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        </div>
      )}
    </SlideOver>
  )
}
