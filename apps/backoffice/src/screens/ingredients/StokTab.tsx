import { useState } from 'react'
import type { Outlet, Warehouse } from '@mandalika/api'
import { ChevronRight, Layers, Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Badge, EmptyState } from '../../ui'
import { IngredientLocationStockView } from './IngredientLocationStockView'

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

export default function StokTab() {
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []

  const [selected, setSelected] = useState<LocationTarget | null>(null)

  if (selected) {
    return <IngredientLocationStockView location={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── OUTLET SECTION ── */}
        <div>
          <p className="text-xs font-black text-gray-400 uppercase tracking-wider mb-3">Outlet</p>

          {!ouq.loading && outlets.length === 0 && (
            <EmptyState icon={<Store />} title="Belum ada outlet" />
          )}

          <div className="space-y-2">
            {outlets.map((o) => (
              <button
                key={o.id}
                onClick={() => setSelected({ kind: 'outlet', id: o.id, name: o.name })}
                className={`w-full flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 hover:border-gold-200 hover:bg-gold-50/30 transition-colors text-left ${
                  o.isActive ? '' : 'opacity-60'
                }`}
              >
                <div className="w-10 h-10 rounded-xl bg-gold-50 grid place-items-center flex-shrink-0">
                  <Store className="w-5 h-5 text-gold-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-900 text-[15px]">{o.name}</span>
                    {!o.isActive && <Badge tone="neutral">Nonaktif</Badge>}
                  </div>
                  <span className="text-xs text-gray-400">Outlet</span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>

        {/* ── GUDANG SECTION ── */}
        <div>
          <p className="text-xs font-black text-gray-400 uppercase tracking-wider mb-3">Gudang</p>

          {!wq.loading && warehouses.length === 0 && (
            <EmptyState icon={<WarehouseIcon />} title="Belum ada gudang" />
          )}

          <div className="space-y-2">
            {warehouses.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelected({ kind: 'warehouse', id: w.id, name: w.name })}
                className={`w-full flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 hover:border-gold-200 hover:bg-gold-50/30 transition-colors text-left ${
                  w.isActive ? '' : 'opacity-60'
                }`}
              >
                <div className="w-10 h-10 rounded-xl bg-gold-50 grid place-items-center flex-shrink-0">
                  <WarehouseIcon className="w-5 h-5 text-gold-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-900 text-[15px]">{w.name}</span>
                    {!w.isActive && <Badge tone="neutral">Nonaktif</Badge>}
                  </div>
                  <span className="text-xs text-gray-400">Gudang</span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {outlets.length === 0 && warehouses.length === 0 && !ouq.loading && !wq.loading && (
        <EmptyState
          icon={<Layers />}
          title="Belum ada lokasi"
          subtitle="Tambahkan outlet atau gudang di menu Stok Produk."
        />
      )}
    </div>
  )
}
