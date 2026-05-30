import { useState } from 'react'
import type { Outlet, Warehouse, InventoryOverviewResponse } from '@mandalika/api'
import {
  Store,
  Warehouse as WarehouseIcon,
  Plus,
  Edit2,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ChevronRight,
} from 'lucide-react'
import { api } from '../../api'
import { useOutlet } from '../../outlet'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { Button, Modal, PageHeader, Tabs, IconButton, Badge, EmptyState } from '../../ui'
import { LocationStockView } from './LocationStockView'
import { OverviewMatrix } from './OverviewMatrix'
import { WarehouseFormModal } from './WarehouseFormModal'
import { OutletFormModal } from './OutletFormModal'

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

interface LocationSummary {
  variantCount: number
  totalStock: number
  lowStockCount: number
}

function buildSummaryMap(data: InventoryOverviewResponse | null): Map<string, LocationSummary> {
  const map = new Map<string, LocationSummary>()
  if (!data) return map
  for (const row of data.rows) {
    for (const cell of row.cells) {
      const prev = map.get(cell.locationId) ?? { variantCount: 0, totalStock: 0, lowStockCount: 0 }
      map.set(cell.locationId, {
        variantCount: prev.variantCount + 1,
        totalStock: prev.totalStock + cell.stock,
        lowStockCount: prev.lowStockCount + (cell.belowPar === true ? 1 : 0),
      })
    }
  }
  return map
}

function SummaryLine({
  locationId,
  kind,
  loading,
  summaryMap,
}: {
  locationId: string
  kind: 'outlet' | 'warehouse'
  loading: boolean
  summaryMap: Map<string, LocationSummary>
}) {
  if (loading) {
    return (
      <span className="inline-block h-3 w-32 bg-gray-100 rounded animate-pulse" />
    )
  }
  const s = summaryMap.get(locationId) ?? { variantCount: 0, totalStock: 0, lowStockCount: 0 }
  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-gray-400">
        {s.variantCount} varian · {s.totalStock} unit
      </span>
      {kind === 'outlet' && s.lowStockCount > 0 && (
        <Badge tone="danger">{s.lowStockCount} stok rendah</Badge>
      )}
    </span>
  )
}

export default function StokProduk() {
  const { refreshOutlets } = useOutlet()
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const oq = usePolledQuery<InventoryOverviewResponse>(() => api.getInventoryOverview(), [])
  const outlets = ouq.data ?? []
  const warehouses = wq.data ?? []
  const summaryMap = buildSummaryMap(oq.data ?? null)
  const summaryLoading = oq.loading

  const [subTab, setSubTab] = useState<SubTab>('lokasi')
  const [selected, setSelected] = useState<LocationTarget | null>(null)

  // Warehouse CRUD state
  const [warehouseFormOpen, setWarehouseFormOpen] = useState(false)
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const [delErr, setDelErr] = useState<string | null>(null)

  // Outlet CRUD state
  const [outletFormOpen, setOutletFormOpen] = useState(false)
  const [editingOutlet, setEditingOutlet] = useState<Outlet | null>(null)

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
      if (selected?.kind === 'warehouse' && selected.id === delId) {
        setSelected(null)
      }
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
    await api.updateOutlet(o.id, {
      name: o.name,
      code: o.code || '',
      address: o.address || '',
      phone: o.phone || '',
      logoUrl: o.logoUrl ?? null,
      isActive: !o.isActive,
    })
    await ouq.refetch()
    await oq.refetch()
    refreshOutlets()
  }

  const onOutletDone = async () => {
    await ouq.refetch()
    await oq.refetch()
    refreshOutlets()
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
        <div className="max-w-xl space-y-6">
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

            {!ouq.loading && outlets.length === 0 && (
              <EmptyState icon={<Store />} title="Belum ada outlet" />
            )}

            <div className="space-y-2">
              {outlets.map((o) => (
                <div
                  key={o.id}
                  className={`flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 hover:border-gold-200 hover:bg-gold-50/30 transition-colors ${
                    o.isActive ? '' : 'opacity-60'
                  }`}
                >
                  {/* Clickable drill-in area */}
                  <button
                    onClick={() => setSelected({ kind: 'outlet', id: o.id, name: o.name })}
                    className="flex flex-1 items-center gap-3 text-left min-w-0"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gold-50 grid place-items-center flex-shrink-0">
                      <Store className="w-5 h-5 text-gold-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-gray-900 text-[15px]">{o.name}</span>
                        {!o.isActive && (
                          <Badge tone="neutral">Nonaktif</Badge>
                        )}
                      </div>
                      <SummaryLine
                        locationId={o.id}
                        kind="outlet"
                        loading={summaryLoading}
                        summaryMap={summaryMap}
                      />
                    </div>
                  </button>

                  {/* Per-row actions — stopPropagation so they don't drill in */}
                  <div
                    className="flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton onClick={() => openEditOutlet(o)} aria-label={`Edit outlet ${o.name}`}>
                      <Edit2 className="w-3.5 h-3.5" />
                    </IconButton>
                    <button
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

                  {/* Drill-in chevron */}
                  <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
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
                  className={`flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3.5 hover:border-gold-200 hover:bg-gold-50/30 transition-colors ${
                    w.isActive ? '' : 'opacity-60'
                  }`}
                >
                  {/* Clickable drill-in area */}
                  <button
                    onClick={() => setSelected({ kind: 'warehouse', id: w.id, name: w.name })}
                    className="flex flex-1 items-center gap-3 text-left min-w-0"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gold-50 grid place-items-center flex-shrink-0">
                      <WarehouseIcon className="w-5 h-5 text-gold-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-gray-900 text-[15px]">{w.name}</span>
                        {!w.isActive && (
                          <Badge tone="neutral">Nonaktif</Badge>
                        )}
                      </div>
                      <SummaryLine
                        locationId={w.id}
                        kind="warehouse"
                        loading={summaryLoading}
                        summaryMap={summaryMap}
                      />
                    </div>
                  </button>

                  {/* Per-row actions */}
                  <div
                    className="flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
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

                  {/* Drill-in chevron */}
                  <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
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

      <OutletFormModal
        open={outletFormOpen}
        editing={editingOutlet}
        onClose={() => setOutletFormOpen(false)}
        onDone={onOutletDone}
      />

      <WarehouseFormModal
        open={warehouseFormOpen}
        editing={editingWarehouse}
        onClose={() => setWarehouseFormOpen(false)}
        onDone={() => wq.refetch()}
      />

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
    </div>
  )
}
