import type { ProductVariant } from '@mandalika/api'
import { Plus, X, Store, FlaskConical } from 'lucide-react'
import { Button } from '../../ui/Button'
import { fieldClass } from '../../ui/Field'

// Disabled look for an ERP-owned control (the shared field class has none).
const ERP_LOCKED = 'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'

interface VariantRowsProps {
  variants: ProductVariant[]
  editing: boolean
  recipesEnabled: boolean
  recipeVariantIds: Set<string>
  productName: string
  onAddVariant: () => void
  onUpdVariant: (i: number, k: keyof ProductVariant, val: string) => void
  onRemoveVariant: (i: number) => void
  setRecipeFor: (r: { variantId: string; label: string }) => void
}

export function VariantRows({
  variants, editing, recipesEnabled, recipeVariantIds, productName,
  onAddVariant, onUpdVariant, onRemoveVariant, setRecipeFor,
}: VariantRowsProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <label htmlFor="variant-size-0" className="text-xs font-black text-gray-400 uppercase tracking-widest">Varian *</label>
        <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} onClick={onAddVariant}>Tambah</Button>
      </div>
      {!editing && (
        <p className="text-[11px] text-gray-400 mb-2 -mt-1 flex items-center gap-1">
          <Store className="w-3 h-3" /> Harga dasar di sini. Stok diatur di menu Inventori.
        </p>
      )}
      {variants.length === 1 && (
        <p className="text-[11px] text-gray-400 mb-2 -mt-1">
          Produk tanpa varian (mis. tas, merchandise): kosongkan Ukuran → otomatis jadi "Satuan".
        </p>
      )}
      <div className="grid grid-cols-12 gap-2 px-1 mb-1">
        <span className="col-span-3 text-[11px] font-bold text-gray-400">Ukuran</span>
        <span className="col-span-3 text-[11px] font-bold text-gray-400">Harga Dasar</span>
        <span className="col-span-3 text-[11px] font-bold text-gray-400">SKU</span>
        <span className="col-span-2 text-[11px] font-bold text-gray-400">Barcode</span>
        <span className="col-span-1" />
      </div>
      <div className="space-y-2">
        {variants.map((v, i) => (
          <div key={v.id || v.size || `new-${i}`} className="grid grid-cols-12 gap-2 items-center">
            {([
              { k: 'size', span: 'col-span-3', ph: '30ml', num: false },
              { k: 'price', span: 'col-span-3', ph: '150000', num: true },
              { k: 'sku', span: 'col-span-3', ph: 'MND-01', num: false },
            ] as const).map(({ k, span, ph, num }) => (
              <input key={k} id={i === 0 && k === 'size' ? 'variant-size-0' : undefined} type={num ? 'number' : 'text'} value={num && v[k] === 0 ? '' : v[k]} onChange={(e) => onUpdVariant(i, k, e.target.value)} placeholder={ph} aria-label={k === 'size' ? 'Ukuran varian' : k === 'price' ? 'Harga dasar varian' : 'SKU varian'}
                disabled={!!v.erpSlug && k !== 'price'} title={v.erpSlug && k !== 'price' ? 'Dikelola ERP' : undefined}
                className={`${fieldClass} ${span} ${v.erpSlug && k !== 'price' ? ERP_LOCKED : ''}`} />
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
                  disabled={!v.id}
                  onClick={() => v.id && setRecipeFor({ variantId: v.id, label: `${productName || 'Produk'} — ${v.size}` })}
                  className={`${v.id && recipeVariantIds.has(v.id) ? 'text-gold-600 bg-gold-50 rounded' : 'text-gray-400'} hover:text-gold-600 disabled:opacity-30`}>
                  <FlaskConical className="w-4 h-4" />
                </button>
              )}
              {v.erpSlug ? (
                <span title="Varian dari ERP tidak bisa dihapus" className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-gold-50 text-gold-700">
                  ERP<span className="sr-only"> (varian dari ERP, tidak bisa dihapus)</span>
                </span>
              ) : (
                <button type="button" onClick={() => onRemoveVariant(i)}
                  disabled={variants.length === 1} className="text-gray-300 hover:text-red-500 disabled:opacity-0">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            {v.erpSlug && v.isActive === false && (
              <p className="col-span-12 text-[11px] font-bold text-amber-700 -mt-1 px-1">Nonaktif (ERP)</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
