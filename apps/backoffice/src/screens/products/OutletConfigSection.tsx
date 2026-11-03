import type { ProductVariant } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { ChevronDown, ChevronRight, Store } from 'lucide-react'
import { fieldClass } from '../../ui/Field'
import type { OcRow, OcfgOutlet } from './types'

interface OutletConfigSectionProps {
  variants: ProductVariant[]
  ocfgLoading: boolean
  ocfgOutlets: OcfgOutlet[]
  ocGet: (oid: string, size: string) => OcRow
  ocSet: (oid: string, size: string, patch: Partial<OcRow>) => void
  setOutletAllAvailable: (oid: string, available: boolean) => void
  basePriceOf: (size: string) => number
  ocCollapsed: Record<string, boolean>
  setOcCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}

export function OutletConfigSection({
  variants, ocfgLoading, ocfgOutlets, ocGet, ocSet,
  setOutletAllAvailable, basePriceOf, ocCollapsed, setOcCollapsed,
}: OutletConfigSectionProps) {
  return (
    <div>
      <label htmlFor="outlet-config-all-0" className="text-xs font-black text-gray-400 uppercase tracking-widest">
        Harga &amp; Ketersediaan per Outlet
      </label>
      {ocfgLoading ? (
        <p className="text-sm text-gray-400 py-3">Memuat data outlet…</p>
      ) : ocfgOutlets.length === 0 ? (
        <p className="text-sm text-gray-400 py-3">Tidak ada outlet aktif.</p>
      ) : (
        <div className="mt-2 space-y-3">
          {ocfgOutlets.map((o, oi) => {
            const sizes = variants.filter((v) => v.size.trim())
            const allOn = sizes.length > 0 && sizes.every((v) => ocGet(o.id, v.size).available)
            const collapsed = ocCollapsed[o.id]
            return (
              <div key={o.id} className="border border-gray-100 rounded-xl">
                <div className="flex items-center justify-between p-3">
                  <button type="button" onClick={() => setOcCollapsed((c) => ({ ...c, [o.id]: !c[o.id] }))} className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
                    {collapsed ? <ChevronRight className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    <Store className="w-3.5 h-3.5 text-gold-600" /> {o.name}
                  </button>
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-gray-500">
                    <input id={oi === 0 ? 'outlet-config-all-0' : undefined} type="checkbox" checked={allOn} onChange={(e) => setOutletAllAvailable(o.id, e.target.checked)} className="w-4 h-4 accent-gold-600" />
                    Dijual di sini (semua)
                  </label>
                </div>
                {!collapsed && (
                  <div className="px-3 pb-3 space-y-1.5">
                    {sizes.length === 0 ? (
                      <p className="text-[11px] text-gray-400">Tambahkan varian dulu di atas.</p>
                    ) : (
                      <>
                        <div className="grid grid-cols-12 gap-2 px-1">
                          <span className="col-span-5" />
                          <span className="col-span-7 text-[10px] font-bold text-gray-400">Harga</span>
                        </div>
                        {sizes.map((v) => {
                          const c = ocGet(o.id, v.size)
                          // The stored size of a single-unit product is internal; people see "Tanpa varian".
                          const name = variantLabel(v.size) || 'Tanpa varian'
                          return (
                            <div key={v.size} className="grid grid-cols-12 gap-2 items-center">
                              <label className="col-span-1 flex justify-center cursor-pointer">
                                <input type="checkbox" checked={c.available} onChange={(e) => ocSet(o.id, v.size, { available: e.target.checked })} aria-label={`Jual ${name} di outlet ini`} className="w-4 h-4 accent-gold-600" />
                              </label>
                              <span className={`col-span-4 text-xs truncate ${c.available ? 'text-gray-600' : 'text-gray-300 line-through'}`}>{name}</span>
                              <input type="number" value={c.price ?? ''} onChange={(e) => ocSet(o.id, v.size, { price: e.target.value === '' ? null : Number(e.target.value) })} placeholder={`${basePriceOf(v.size)}`} disabled={!c.available} aria-label={`Harga ${name} di outlet ini`} className={`${fieldClass} col-span-7 py-1.5 disabled:opacity-40`} />
                            </div>
                          )
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <p className="text-[11px] text-gray-400">Centang = dijual di outlet itu. Harga kosong = pakai harga dasar varian.</p>
        </div>
      )}
    </div>
  )
}
