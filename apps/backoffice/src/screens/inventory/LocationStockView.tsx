import { useState } from 'react'
import type { WarehouseStockRow } from '@mandalika/api'
import { ArrowLeft, Package, PackagePlus, Search, SlidersHorizontal } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Badge, Button, Card, EmptyState, PageHeader, fieldClass } from '../../ui'
import { GoodsInModal } from '../warehouses/GoodsInModal'
import { AdjustModal } from '../warehouses/AdjustModal'

const rowKey = (productId: string, variantSize: string) => `${productId}|${variantSize}`

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

interface LocationStockViewProps {
  location: LocationTarget
  onBack: () => void
}

export function LocationStockView({ location, onBack }: LocationStockViewProps) {
  const sq = usePolledQuery<WarehouseStockRow[]>(
    () => api.getTransferLocationStock(location.kind, location.id),
    [location.kind, location.id],
  )
  const rows = sq.data ?? []

  const [search, setSearch] = useState('')
  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    return r.productName.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q)
  })

  const [giOpen, setGiOpen] = useState(false)
  const [adjRow, setAdjRow] = useState<WarehouseStockRow | null>(null)
  const [parErr, setParErr] = useState<string | null>(null)

  const isOutlet = location.kind === 'outlet'

  const stockBadgeTone = (r: WarehouseStockRow): 'danger' | 'neutral' => {
    if (isOutlet && r.parLevel != null && r.stock <= r.parLevel) return 'danger'
    if (!isOutlet && r.stock <= 5) return 'danger'
    return 'neutral'
  }

  const columnHeaders = isOutlet
    ? ['Produk', 'Ukuran', 'SKU', 'Stok', 'PAR', 'Aksi']
    : ['Produk', 'Ukuran', 'SKU', 'Stok', 'Aksi']

  const subtitle = isOutlet
    ? `Stok outlet · ${rows.length} varian`
    : `Stok gudang · ${rows.length} varian`

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title={location.name}
        subtitle={subtitle}
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

      {parErr && <p className="text-sm text-red-600">{parErr}</p>}

      <Card className="overflow-hidden">
        {sq.loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Package />}
            title={rows.length === 0 ? 'Belum ada stok di lokasi ini' : 'Tidak ada hasil'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {columnHeaders.map((h) => (
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
                      <Badge tone={stockBadgeTone(r)}>{r.stock}</Badge>
                    </td>
                    {isOutlet && (
                      <td className="px-5 py-3">
                        <input
                          type="number"
                          defaultValue={r.parLevel ?? ''}
                          placeholder="—"
                          title="Batas stok menipis (PAR)"
                          onBlur={async (e) => {
                            const v = e.target.value === '' ? null : Number(e.target.value)
                            try {
                              setParErr(null)
                              await api.setOutletPar(location.id, {
                                productId: r.productId,
                                variantSize: r.variantSize,
                                parLevel: v,
                              })
                              await sq.refetch()
                            } catch (err) {
                              setParErr(err instanceof Error ? err.message : 'Gagal menyimpan PAR.')
                            }
                          }}
                          className={`${fieldClass} w-20 py-1.5`}
                        />
                      </td>
                    )}
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
        location={location}
        rows={rows}
        onClose={() => setGiOpen(false)}
        onDone={() => sq.refetch()}
      />

      {adjRow && (
        <AdjustModal
          location={location}
          row={adjRow}
          onClose={() => setAdjRow(null)}
          onDone={() => sq.refetch()}
        />
      )}
    </div>
  )
}
