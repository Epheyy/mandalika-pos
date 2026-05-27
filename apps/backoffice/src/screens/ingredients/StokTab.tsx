import { useEffect, useState } from 'react'
import type { IngredientStockRow, Warehouse } from '@mandalika/api'
import { Layers } from 'lucide-react'
import { api } from '../../api'
import { TableSkeleton } from '../../components/Skeleton'
import { EmptyState } from '../../ui'

const formatQty = (n: number) =>
  n.toLocaleString('id-ID', { maximumFractionDigits: 3 })

const formatIDR = (n: number | null | undefined) => {
  if (n == null) return '—'
  return n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
}

export default function StokTab() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState<string>('')
  const [rows, setRows] = useState<IngredientStockRow[]>([])
  const [loadingWh, setLoadingWh] = useState(true)
  const [loadingStock, setLoadingStock] = useState(false)
  const [errWh, setErrWh] = useState<string | null>(null)
  const [errStock, setErrStock] = useState<string | null>(null)

  // Load warehouses once on mount
  useEffect(() => {
    api
      .listWarehouses()
      .then((whs) => {
        const active = whs.filter((w) => w.isActive)
        setWarehouses(active)
        if (active.length > 0) setWarehouseId(active[0].id)
      })
      .catch((e: unknown) => setErrWh(e instanceof Error ? e.message : 'Gagal memuat gudang.'))
      .finally(() => setLoadingWh(false))
  }, [])

  // Load stock whenever warehouseId changes
  useEffect(() => {
    if (!warehouseId) return
    setLoadingStock(true)
    setErrStock(null)
    api
      .getIngredientStock(warehouseId)
      .then(setRows)
      .catch((e: unknown) => setErrStock(e instanceof Error ? e.message : 'Gagal memuat stok.'))
      .finally(() => setLoadingStock(false))
  }, [warehouseId])

  if (loadingWh) return <TableSkeleton rows={4} />
  if (errWh) return <p className="text-sm text-red-600 p-4">{errWh}</p>
  if (warehouses.length === 0)
    return (
      <p className="text-sm text-gray-500 p-4">
        Belum ada gudang aktif. Tambahkan gudang di tab Gudang.
      </p>
    )

  return (
    <div>
      {/* Warehouse picker */}
      <div className="mb-4 max-w-xs">
        <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">
          Gudang
        </label>
        <select
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
        >
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {/* Stock table */}
      {loadingStock ? (
        <TableSkeleton rows={5} />
      ) : errStock ? (
        <p className="text-sm text-red-600">{errStock}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="Stok kosong"
          subtitle="Belum ada bahan di gudang ini. Tambahkan stok melalui Stok Masuk."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Nama
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Satuan
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest text-right">
                  Stok
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest text-right">
                  Biaya Default
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.ingredientId} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-3 text-gray-600">{r.unit}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-800 font-medium">
                    {formatQty(r.qty)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {formatIDR(r.defaultUnitCost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
