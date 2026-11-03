import type { ProductVariant } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Plus, X, Store, FlaskConical } from 'lucide-react'
import { Button } from '../../ui/Button'
import { fieldClass } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { FIELD_ID } from './validateForm'

// Disabled look for an ERP-owned control (the shared field class has none).
const ERP_LOCKED = 'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'
const INVALID = 'border-red-300'

interface VariantRowsProps {
  variants: ProductVariant[]
  editing: boolean
  recipesEnabled: boolean
  recipeVariantIds: Set<string>
  productName: string
  /** Messages by control id (see FIELD_ID); shown under the row and wired to aria-invalid. */
  errors?: Readonly<Record<string, string>>
  onAddVariant: () => void
  onUpdVariant: (i: number, k: keyof ProductVariant, val: string) => void
  onRemoveVariant: (i: number) => void
  setRecipeFor: (r: { variantId: string; label: string }) => void
}

export function VariantRows({
  variants, editing, recipesEnabled, recipeVariantIds, productName, errors = {},
  onAddVariant, onUpdVariant, onRemoveVariant, setRecipeFor,
}: VariantRowsProps) {
  const single = variants.length === 1
  // A single-unit product stores the internal size "Satuan"; its Ukuran box shows empty instead.
  const shownSize = (v: ProductVariant) => (single ? variantLabel(v.size) : v.size)
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <label htmlFor={FIELD_ID.size(0)} className="text-xs font-black text-ink-700 uppercase tracking-widest">Varian *</label>
        <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={onAddVariant}>Tambah</Button>
      </div>
      {!editing && (
        <p className="text-[11px] text-ink-700 mb-2 -mt-1 flex items-center gap-1">
          <Store className="w-3 h-3" /> Harga dasar di sini. Stok diatur di menu Inventori.
        </p>
      )}
      {single && (
        <p className="text-[11px] text-ink-700 mb-2 -mt-1">
          Produk tanpa varian (mis. tas, merchandise): kosongkan Ukuran, produk dijual per satuan.
        </p>
      )}
      <div className="grid grid-cols-12 gap-2 px-1 mb-1">
        <span className="col-span-3 text-[11px] font-bold text-ink-700">Ukuran</span>
        <span className="col-span-3 text-[11px] font-bold text-ink-700">Harga Dasar</span>
        <span className="col-span-3 text-[11px] font-bold text-ink-700">SKU</span>
        <span className="col-span-2 text-[11px] font-bold text-ink-700">Barcode</span>
        <span className="col-span-1" />
      </div>
      <div className="space-y-2">
        {variants.map((v, i) => {
          const fields = [
            { k: 'size', id: FIELD_ID.size(i), span: 'col-span-3', ph: '30ml', num: false, label: 'Ukuran varian', value: shownSize(v) },
            { k: 'price', id: FIELD_ID.price(i), span: 'col-span-3', ph: '150000', num: true, label: 'Harga dasar varian', value: v.price === 0 ? '' : v.price },
            { k: 'sku', id: FIELD_ID.sku(i), span: 'col-span-3', ph: 'MND-01', num: false, label: 'SKU varian', value: v.sku },
          ] as const
          const rowErrors = fields.map((f) => errors[f.id]).filter((m): m is string => !!m)
          return (
            <div key={v.id ?? `new-${i}`} className="grid grid-cols-12 gap-2 items-center">
              {fields.map(({ k, id, span, ph, num, label, value }) => (
                <input key={k} id={id} type={num ? 'number' : 'text'} value={value} onChange={(e) => onUpdVariant(i, k, e.target.value)} placeholder={ph} aria-label={label}
                  aria-invalid={errors[id] ? true : undefined}
                  disabled={!!v.erpSlug && k !== 'price'} title={v.erpSlug && k !== 'price' ? 'Dikelola ERP' : undefined}
                  className={cn(fieldClass, span, v.erpSlug && k !== 'price' && ERP_LOCKED, errors[id] && INVALID)} />
              ))}
              <input
                type="text"
                value={v.barcode ?? ''}
                onChange={(e) => onUpdVariant(i, 'barcode', e.target.value)}
                placeholder={v.sku.trim() || '= SKU'}
                aria-label="Barcode varian"
                title="Kosongkan untuk memakai SKU sebagai barcode"
                className={`${fieldClass} col-span-2`}
              />
              <div className="col-span-1 flex items-center justify-center gap-1">
                {recipesEnabled && (
                  <button type="button"
                    title={!v.id ? 'Simpan produk dulu' : (recipeVariantIds.has(v.id) ? 'Resep tersedia' : 'Belum ada resep')}
                    aria-label={`Resep ${variantLabel(v.size) || productName || 'produk'}`}
                    disabled={!v.id}
                    onClick={() => v.id && setRecipeFor({ variantId: v.id, label: [productName || 'Produk', variantLabel(v.size)].filter(Boolean).join(' — ') })}
                    className={`${v.id && recipeVariantIds.has(v.id) ? 'text-gold-600 bg-gold-50 rounded' : 'text-gray-400'} hover:text-gold-600 disabled:opacity-30`}>
                    <FlaskConical className="w-4 h-4" />
                  </button>
                )}
                {v.erpSlug ? (
                  <span title="Varian dari ERP tidak bisa dihapus" className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-gold-50 text-gold-700">
                    ERP<span className="sr-only"> (varian dari ERP, tidak bisa dihapus)</span>
                  </span>
                ) : (
                  <button type="button" onClick={() => onRemoveVariant(i)} aria-label="Hapus varian"
                    disabled={variants.length === 1} className="text-gray-300 hover:text-red-500 disabled:opacity-0">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {rowErrors.length > 0 && (
                <p className="col-span-12 text-[11px] text-red-600 -mt-1 px-1">{[...new Set(rowErrors)].join('. ')}</p>
              )}
              {v.erpSlug && v.isActive === false && (
                <p className="col-span-12 text-[11px] font-bold text-amber-700 -mt-1 px-1">Nonaktif (ERP)</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
