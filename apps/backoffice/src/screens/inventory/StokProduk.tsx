import { useState } from 'react'
import type { Outlet, Warehouse } from '@mandalika/api'
import { Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { PageHeader, Tabs } from '../../ui'
import { LocationStockView } from './LocationStockView'
import { OverviewMatrix } from './OverviewMatrix'

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

type SubTab = 'lokasi' | 'overview'

const SUB_TABS: ReadonlyArray<{ id: SubTab; label: string }> = [
  { id: 'lokasi', label: 'Lokasi' },
  { id: 'overview', label: 'Overview' },
]

export default function StokProduk() {
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []

  const [subTab, setSubTab] = useState<SubTab>('lokasi')
  const [selected, setSelected] = useState<LocationTarget | null>(null)

  if (selected) {
    return <LocationStockView location={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Stok Produk"
        subtitle="Pilih lokasi untuk melihat dan mengelola stok"
      />

      <Tabs value={subTab} onChange={setSubTab} tabs={SUB_TABS} />

      {subTab === 'lokasi' && (
        <div className="max-w-xl space-y-1">
          <p className="text-xs font-black text-gray-400 uppercase mb-2">Outlet</p>
          {outlets.length === 0 && !ouq.loading && (
            <p className="text-sm text-gray-400 px-4 py-2">Belum ada outlet terdaftar.</p>
          )}
          {outlets.map((o) => (
            <button
              key={o.id}
              onClick={() => setSelected({ kind: 'outlet', id: o.id, name: o.name })}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 flex items-center gap-3"
            >
              <Store className="w-4 h-4 text-gold-600 flex-shrink-0" />
              <span className="font-bold text-sm text-gray-900">{o.name}</span>
            </button>
          ))}

          <p className="text-xs font-black text-gray-400 uppercase mt-4 mb-2">Gudang</p>
          {warehouses.length === 0 && !wq.loading && (
            <p className="text-sm text-gray-400 px-4 py-2">Belum ada gudang terdaftar.</p>
          )}
          {warehouses.map((w) => (
            <button
              key={w.id}
              onClick={() => setSelected({ kind: 'warehouse', id: w.id, name: w.name })}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-50 flex items-center gap-3"
            >
              <WarehouseIcon className="w-4 h-4 text-gold-600 flex-shrink-0" />
              <span className="font-bold text-sm text-gray-900">{w.name}</span>
            </button>
          ))}
        </div>
      )}

      {subTab === 'overview' && (
        <OverviewMatrix
          onPickLocation={(loc) => {
            setSubTab('lokasi')
            setSelected(loc)
          }}
        />
      )}
    </div>
  )
}
