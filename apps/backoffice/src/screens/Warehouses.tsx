import { useState } from 'react'
import type { Warehouse, WarehouseInput, WarehouseStockRow } from '@mandalika/api'
import {
  Plus,
  Edit2,
  Trash2,
  Warehouse as WarehouseIcon,
  Package,
  Search,
  ArrowLeft,
  PackagePlus,
  SlidersHorizontal,
} from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import {
  Button,
  Card,
  Badge,
  Modal,
  Input,
  Textarea,
  IconButton,
  EmptyState,
  PageHeader,
  fieldClass,
} from '../ui'
import { GoodsInModal } from './warehouses/GoodsInModal'
import { AdjustModal } from './warehouses/AdjustModal'

const EMPTY_WAREHOUSE = { name: '', code: '', address: '', phone: '', isActive: true }
const rowKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

export default function Warehouses() {
  const wq = usePolledQuery<Warehouse[]>(() => api.listWarehouses(), [])
  const warehouses = wq.data ?? []

  // Selected warehouse drives the stock view; null = list view.
  const [selected, setSelected] = useState<Warehouse | null>(null)

  // ---- Warehouse CRUD modal ----
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Warehouse | null>(null)
  const [form, setForm] = useState(EMPTY_WAREHOUSE)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [delId, setDelId] = useState<string | null>(null)

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY_WAREHOUSE)
    setErr(null)
    setOpen(true)
  }
  const openEdit = (w: Warehouse) => {
    setEditing(w)
    setForm({
      name: w.name,
      code: w.code || '',
      address: w.address || '',
      phone: w.phone || '',
      isActive: w.isActive,
    })
    setErr(null)
    setOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) {
      setErr('Nama gudang wajib diisi')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body: WarehouseInput = {
        name: form.name.trim(),
        code: form.code.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        isActive: form.isActive,
      }
      if (editing) await api.updateWarehouse(editing.id, body)
      else await api.createWarehouse(body)
      setOpen(false)
      await wq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan gudang.')
    } finally {
      setBusy(false)
    }
  }

  const del = async (id: string) => {
    try {
      await api.deleteWarehouse(id)
      setDelId(null)
      if (selected?.id === id) setSelected(null)
      await wq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menghapus gudang.')
      setDelId(null)
    }
  }

  if (selected) {
    return <StockView warehouse={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Gudang"
        subtitle={`${warehouses.length} gudang terdaftar`}
        actions={
          <Button onClick={openAdd} icon={<Plus className="w-4 h-4" />}>
            Tambah Gudang
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {wq.loading ? (
          <TableSkeleton />
        ) : warehouses.length === 0 ? (
          <EmptyState icon={<WarehouseIcon />} title="Belum ada gudang" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Gudang', 'Kode', 'Alamat', 'Telepon', 'Status', 'Aksi'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {warehouses.map((w) => (
                  <tr
                    key={w.id}
                    onClick={() => setSelected(w)}
                    className={`hover:bg-gray-50 cursor-pointer ${w.isActive ? '' : 'opacity-60'}`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gold-50 rounded-xl flex items-center justify-center flex-shrink-0">
                          <WarehouseIcon className="w-5 h-5 text-gold-600" />
                        </div>
                        <p className="font-bold text-gray-900 text-sm">{w.name}</p>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-500 font-mono">{w.code || '—'}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{w.address || '—'}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{w.phone || '—'}</td>
                    <td className="px-5 py-3">
                      <Badge tone={w.isActive ? 'success' : 'neutral'}>
                        {w.isActive ? 'Aktif' : 'Nonaktif'}
                      </Badge>
                    </td>
                    <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Package className="w-3.5 h-3.5" />}
                          onClick={() => setSelected(w)}
                        >
                          Kelola Stok
                        </Button>
                        <IconButton onClick={() => openEdit(w)} aria-label="Edit gudang">
                          <Edit2 className="w-4 h-4" />
                        </IconButton>
                        <IconButton
                          tone="danger"
                          onClick={() => setDelId(w.id)}
                          aria-label="Hapus gudang"
                        >
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit Gudang' : 'Tambah Gudang'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
              Batal
            </Button>
            <Button className="flex-1" onClick={save} loading={busy}>
              {busy ? 'Menyimpan...' : editing ? 'Simpan' : 'Tambah'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Nama Gudang *"
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Input
            label="Kode"
            type="text"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="mis. GDG-01"
          />
          <Textarea
            label="Alamat"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            rows={2}
          />
          <Input
            label="No. Telepon"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="w-4 h-4 accent-gold-600"
            />
            <span className="text-sm font-bold text-gray-700">Gudang Aktif</span>
          </label>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>

      <Modal
        open={!!delId}
        onClose={() => setDelId(null)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setDelId(null)}>
              Batal
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => delId && del(delId)}>
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
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stock view for a selected warehouse: searchable on-hand table + goods-in +
// per-row adjust. Loads its own stock query so it stays isolated from the list.
// ---------------------------------------------------------------------------
function StockView({ warehouse, onBack }: { warehouse: Warehouse; onBack: () => void }) {
  const sq = usePolledQuery<WarehouseStockRow[]>(
    () => api.getWarehouseStock(warehouse.id),
    [warehouse.id],
  )
  const rows = sq.data ?? []
  const [search, setSearch] = useState('')
  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    return r.productName.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q)
  })

  const [giOpen, setGiOpen] = useState(false)
  const [adjRow, setAdjRow] = useState<WarehouseStockRow | null>(null)

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title={warehouse.name}
        subtitle={`Stok gudang · ${rows.length} varian`}
        actions={
          <>
            <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} onClick={onBack}>
              Kembali
            </Button>
            <Button icon={<PackagePlus className="w-4 h-4" />} onClick={() => setGiOpen(true)}>
              Barang Masuk
            </Button>
          </>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
        <input
          type="text"
          placeholder="Cari produk / SKU..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${fieldClass} pl-9`}
        />
      </div>

      <Card className="overflow-hidden">
        {sq.loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Package />}
            title={rows.length === 0 ? 'Belum ada stok di gudang ini' : 'Tidak ada hasil'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Produk', 'Ukuran', 'SKU', 'Stok', 'Aksi'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((r) => (
                  <tr key={rowKey(r.productId, r.variantSize)} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-bold text-gray-900 text-sm">{r.productName}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{r.variantSize}</td>
                    <td className="px-5 py-3 text-sm text-gray-500 font-mono">{r.sku || '—'}</td>
                    <td className="px-5 py-3">
                      <Badge tone={r.stock <= 5 ? 'danger' : 'neutral'}>{r.stock}</Badge>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
                          onClick={() => setAdjRow(r)}
                        >
                          Koreksi
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <GoodsInModal
        open={giOpen}
        warehouse={warehouse}
        rows={rows}
        onClose={() => setGiOpen(false)}
        onDone={() => sq.refetch()}
      />

      {adjRow && (
        <AdjustModal
          warehouse={warehouse}
          row={adjRow}
          onClose={() => setAdjRow(null)}
          onDone={() => sq.refetch()}
        />
      )}
    </div>
  )
}
