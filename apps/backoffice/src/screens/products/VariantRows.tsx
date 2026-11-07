import type { ProductVariant } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Plus, X, Store, FlaskConical } from 'lucide-react'
import { Button } from '../../ui/Button'
import { IconButton } from '../../ui/IconButton'
import { fieldClass } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { MoneyField } from './MoneyField'
import { FIELD_ID } from './validateForm'

// Disabled look for an ERP-owned control (the shared field class has none).
const ERP_LOCKED = 'disabled:bg-paper-1 disabled:text-ink-700 disabled:cursor-not-allowed'
const INVALID = 'border-danger!'

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
      <label htmlFor={FIELD_ID.size(0)} className="block mb-3 text-xs font-black text-ink-700 uppercase tracking-widest">Varian *</label>
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
        <span className="col-span-2 text-[11px] font-bold text-ink-700">SKU</span>
        <span className="col-span-2 text-[11px] font-bold text-ink-700">Barcode</span>
        <span className="col-span-3 text-[11px] font-bold text-ink-700">Harga dasar</span>
        <span className="col-span-2" />
      </div>
      <div className="space-y-2">
        {variants.map((v, i) => {
          const locked = !!v.erpSlug
          const textFields = [
            { k: 'size', id: FIELD_ID.size(i), span: 'col-span-3', ph: '30ml', label: 'Ukuran varian', value: shownSize(v) },
            { k: 'sku', id: FIELD_ID.sku(i), span: 'col-span-2', ph: 'MND-01', label: 'SKU varian', value: v.sku },
          ] as const
          const rowErrors = [FIELD_ID.size(i), FIELD_ID.price(i), FIELD_ID.sku(i)].map((id) => errors[id]).filter((m): m is string => !!m)
          const textInput = ({ k, id, span, ph, label, value }: (typeof textFields)[number]) => (
            <input key={k} id={id} type="text" value={value} onChange={(e) => onUpdVariant(i, k, e.target.value)} placeholder={ph} aria-label={label}
              aria-invalid={errors[id] ? true : undefined}
              disabled={locked} title={locked ? 'Dikelola ERP' : undefined}
              className={cn(fieldClass, span, locked && ERP_LOCKED, errors[id] && INVALID)} />
          )
          return (
            <div key={v.id ?? `new-${i}`} className="grid grid-cols-12 gap-2 items-center">
              {textInput(textFields[0])}
              {textInput(textFields[1])}
              <input
                type="text"
                value={v.barcode ?? ''}
                onChange={(e) => onUpdVariant(i, 'barcode', e.target.value)}
                placeholder={v.sku.trim() || '= SKU'}
                aria-label="Barcode varian"
                title="Kosongkan untuk memakai SKU sebagai barcode"
                className={`${fieldClass} col-span-2`}
              />
              <MoneyField
                id={FIELD_ID.price(i)}
                raw={v.price === 0 ? '' : String(v.price)}
                onRawChange={(raw) => onUpdVariant(i, 'price', raw)}
                label="Harga dasar varian"
                placeholder="Rp 150.000"
                invalid={!!errors[FIELD_ID.price(i)]}
                className={cn('col-span-3', errors[FIELD_ID.price(i)] && INVALID)}
              />
              <div className="col-span-2 flex items-center justify-end gap-0.5">
                {recipesEnabled && (
                  <IconButton
                    label={`Resep ${variantLabel(v.size) || productName || 'produk'}`}
                    title={!v.id ? 'Simpan produk dulu' : (recipeVariantIds.has(v.id) ? 'Resep tersedia' : 'Belum ada resep')}
                    disabled={!v.id}
                    onClick={() => v.id && setRecipeFor({ variantId: v.id, label: [productName || 'Produk', variantLabel(v.size)].filter(Boolean).join(' — ') })}
                    className={`${v.id && recipeVariantIds.has(v.id) ? 'text-brand-strong! bg-paper-1' : ''} disabled:opacity-40`}>
                    <FlaskConical className="w-4 h-4" aria-hidden="true" />
                  </IconButton>
                )}
                {v.erpSlug ? (
                  <span title="Varian dari ERP tidak bisa dihapus" className="px-1.5 py-0.5 text-[11px] font-bold rounded bg-paper-1 text-ink-700">
                    ERP<span className="sr-only"> (varian dari ERP, tidak bisa dihapus)</span>
                  </span>
                ) : (
                  <IconButton tone="danger" label="Hapus varian" onClick={() => onRemoveVariant(i)} disabled={variants.length === 1} className="disabled:opacity-0">
                    <X className="w-4 h-4" aria-hidden="true" />
                  </IconButton>
                )}
              </div>
              {rowErrors.length > 0 && (
                <p className="col-span-12 text-[11px] text-danger -mt-1 px-1">{[...new Set(rowErrors)].join('. ')}</p>
              )}
              {v.erpSlug && v.isActive === false && (
                <p className="col-span-12 text-[11px] font-bold text-warn-strong -mt-1 px-1">Nonaktif (ERP)</p>
              )}
            </div>
          )
        })}
      </div>
      <Button variant="ghost" size="sm" className="mt-2" icon={<Plus className="w-3 h-3" />} onClick={onAddVariant}>Tambah varian</Button>
    </div>
  )
}
