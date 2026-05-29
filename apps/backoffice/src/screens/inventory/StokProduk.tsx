import { useState } from 'react'
import type { Outlet, Warehouse } from '@mandalika/api'
import { Store, Warehouse as WarehouseIcon, Plus, Edit2, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Button, Modal, PageHeader, Tabs, IconButton } from '../../ui'
import { LocationStockView } from './LocationStockView'
import { OverviewMatrix } from './OverviewMatrix'
import { WarehouseFormModal } from './WarehouseFormModal'

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

  // Warehouse CRUD state
  const [formOpen, setFormOpen] = useState(false)
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)

  const openAdd = () => {
    setEditingWarehouse(null)
    setFormOpen(true)
  }

  const openEdit = (w: Warehouse) => {
    setEditingWarehouse(w)
    setFormOpen(true)
  }

  const confirmDelete = (w: Warehouse) => {
    setDelErr(null)
    setDelId(w.id)
  }

  const del = async () => {
    if (!delId) return
    try {
      await api.deleteWarehouse(delId)
      setDelId(null)
      setDelErr(null)
      // If the deleted warehouse is currently selected, go back to list
      if (selected?.kind === 'warehouse' && selected.id === delId) {
        setSelected(null)
      }
      await wq.refetch()
    } catch (e: unknown) {
      setDelErr(e instanceof Error ? e.message : 'Gagal menghapus gudang.')
    }
  }

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

          <div className="flex items-center justify-between mt-4 mb-2">
            <p className="text-xs font-black text-gray-400 uppercase">Gudang</p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={openAdd}
            >
              Tambah Gudang
            </Button>
          </div>
          {warehouses.length === 0 && !wq.loading && (
            <p className="text-sm text-gray-400 px-4 py-2">Belum ada gudang terdaftar.</p>
          )}
          {warehouses.map((w) => (
            <div
              key={w.id}
              className={`flex items-center gap-3 rounded-xl hover:bg-gray-50 ${w.isActive ? '' : 'opacity-60'}`}
            >
              <button
                onClick={() => setSelected({ kind: 'warehouse', id: w.id, name: w.name })}
                className="flex-1 text-left px-4 py-3 flex items-center gap-3"
              >
                <WarehouseIcon className="w-4 h-4 text-gold-600 flex-shrink-0" />
                <span className="font-bold text-sm text-gray-900">{w.name}</span>
                {!w.isActive && (
                  <span className="text-xs text-gray-400 font-normal">(nonaktif)</span>
                )}
              </button>
              <div
                className="flex items-center gap-1 pr-2"
                onClick={(e) => e.stopPropagation()}
              >
                <IconButton onClick={() => openEdit(w)} aria-label={`Edit gudang ${w.name}`}>
                  <Edit2 className="w-3.5 h-3.5" />
                </IconButton>
                <IconButton
                  tone="danger"
                  onClick={() => confirmDelete(w)}
                  aria-label={`Hapus gudang ${w.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            </div>
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

      <WarehouseFormModal
        open={formOpen}
        editing={editingWarehouse}
        onClose={() => setFormOpen(false)}
        onDone={() => wq.refetch()}
      />

      {/* Delete confirmation */}
      <Modal
        open={!!delId}
        onClose={() => { setDelId(null); setDelErr(null) }}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => { setDelId(null); setDelErr(null) }}
            >
              Batal
            </Button>
            <Button variant="danger" className="flex-1" onClick={del}>
              Ya, Hapus
            </Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Trash2 className="w-7 h-7 text-red-500" />
          </div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
          <p className="text-sm text-gray-400">Data tidak dapat dikembalikan.</p>
          {delErr && <p className="text-sm text-red-600 mt-2">{delErr}</p>}
        </div>
      </Modal>
    </div>
  )
}
