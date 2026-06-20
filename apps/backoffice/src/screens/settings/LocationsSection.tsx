import { useState } from 'react'
import type { Outlet, Warehouse } from '@mandalika/api'
import {
  Store,
  Warehouse as WarehouseIcon,
  Plus,
  Edit2,
  Trash2,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react'
import { api } from '../../api'
import { useOutlet } from '../../outlet'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'
import { Badge } from '../../ui/Badge'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { OutletFormModal } from '../inventory/OutletFormModal'
import { WarehouseFormModal } from '../inventory/WarehouseFormModal'

export function LocationsSection() {
  const { refreshOutlets } = useOutlet()
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []

  // Warehouse CRUD state
  const [warehouseFormOpen, setWarehouseFormOpen] = useState(false)
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)

  // Outlet CRUD state
  const [outletFormOpen, setOutletFormOpen] = useState(false)
  const [editingOutlet, setEditingOutlet] = useState<Outlet | null>(null)
  const [toggleErr, setToggleErr] = useState<string | null>(null)

  const openAddWarehouse = () => {
    setEditingWarehouse(null)
    setWarehouseFormOpen(true)
  }

  const openEditWarehouse = (w: Warehouse) => {
    setEditingWarehouse(w)
    setWarehouseFormOpen(true)
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
      await wq.refetch()
    } catch (e: unknown) {
      setDelErr(e instanceof Error ? e.message : 'Gagal menghapus gudang.')
    }
  }

  const openAddOutlet = () => {
    setEditingOutlet(null)
    setOutletFormOpen(true)
  }

  const openEditOutlet = (o: Outlet) => {
    setEditingOutlet(o)
    setOutletFormOpen(true)
  }

  const toggleOutlet = async (o: Outlet) => {
    try {
      setToggleErr(null)
      await api.updateOutlet(o.id, {
        name: o.name,
        code: o.code || '',
        address: o.address || '',
        phone: o.phone || '',
        logoUrl: o.logoUrl ?? null,
        isActive: !o.isActive,
      })
      await ouq.refetch()
      refreshOutlets()
    } catch (e: unknown) {
      setToggleErr(e instanceof Error ? e.message : 'Gagal mengubah status outlet.')
    }
  }

  const onOutletDone = async () => {
    await ouq.refetch()
    refreshOutlets()
  }

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── OUTLET SECTION ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-black text-gray-400 uppercase tracking-wider">Outlet</p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={openAddOutlet}
            >
              Tambah Outlet
            </Button>
          </div>

          {toggleErr && <p className="mb-2 text-sm text-red-600">{toggleErr}</p>}

          {!ouq.loading && outlets.length === 0 && (
            <EmptyState icon={<Store />} title="Belum ada outlet" />
          )}

          <div className="space-y-2">
            {outlets.map((o) => (
              <div
                key={o.id}
                className={`flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 transition-colors ${
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
                  {o.code && (
                    <span className="text-xs text-gray-400 font-mono">{o.code}</span>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  <IconButton onClick={() => openEditOutlet(o)} aria-label={`Edit outlet ${o.name}`}>
                    <Edit2 className="w-3.5 h-3.5" />
                  </IconButton>
                  <button type="button"
                    onClick={() => toggleOutlet(o)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gold-600 transition-colors"
                    aria-label={o.isActive ? 'Nonaktifkan outlet' : 'Aktifkan outlet'}
                  >
                    {o.isActive ? (
                      <ToggleRight className="w-5 h-5 text-gold-600" />
                    ) : (
                      <ToggleLeft className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── GUDANG SECTION ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-black text-gray-400 uppercase tracking-wider">Gudang</p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={openAddWarehouse}
            >
              Tambah Gudang
            </Button>
          </div>

          {!wq.loading && warehouses.length === 0 && (
            <EmptyState icon={<WarehouseIcon />} title="Belum ada gudang" />
          )}

          <div className="space-y-2">
            {warehouses.map((w) => (
              <div
                key={w.id}
                className={`flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 transition-colors ${
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
                  {w.code && (
                    <span className="text-xs text-gray-400 font-mono">{w.code}</span>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  <IconButton
                    onClick={() => openEditWarehouse(w)}
                    aria-label={`Edit gudang ${w.name}`}
                  >
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
        </div>
      </div>

      {outletFormOpen && (
        <OutletFormModal
          key={editingOutlet?.id ?? 'new'}
          editing={editingOutlet}
          onClose={() => setOutletFormOpen(false)}
          onDone={onOutletDone}
        />
      )}

      {warehouseFormOpen && (
        <WarehouseFormModal
          key={editingWarehouse?.id ?? 'new'}
          editing={editingWarehouse}
          onClose={() => setWarehouseFormOpen(false)}
          onDone={() => wq.refetch()}
        />
      )}

      {/* Delete warehouse confirmation */}
      <Modal
        open={!!delId}
        onClose={() => {
          setDelId(null)
          setDelErr(null)
        }}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                setDelId(null)
                setDelErr(null)
              }}
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
    </>
  )
}
