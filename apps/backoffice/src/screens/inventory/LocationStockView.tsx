import { useState } from 'react'
import type { WarehouseStockRow } from '@mandalika/api'
import { ArrowLeft, Package, PackagePlus, Search, SlidersHorizontal } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button } from '../../ui/Button'
import { fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { useToast } from '../../ui/Toast'
import { GoodsInSlideOver } from '../warehouses/GoodsInSlideOver'
import { AdjustSlideOver } from '../warehouses/AdjustSlideOver'
import { parChanged, parseParInput } from './parLevel'

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
  const toast = useToast()

  const isOutlet = location.kind === 'outlet'

  // Saves a PAR only when the box holds a different, valid value than what is stored; anything else puts the
  // stored value back so the box never shows something that was not saved.
  const savePar = async (r: WarehouseStockRow, input: HTMLInputElement) => {
    // A number box holding text like "-" or "5e" reports an empty value: that is bad input, not a cleared PAR.
    const parsed = input.validity.badInput ? ({ ok: false } as const) : parseParInput(input.value)
    if (!parsed.ok) {
      setParErr('PAR harus berupa bilangan bulat 0 atau lebih, atau dikosongkan.')
      input.value = r.parLevel == null ? '' : String(r.parLevel)
      return
    }
    setParErr(null)
    if (!parChanged(parsed.value, r.parLevel)) return
    try {
      await api.setOutletPar(location.id, { productId: r.productId, variantSize: r.variantSize, parLevel: parsed.value })
      toast({
        message: parsed.value === null ? `PAR ${r.productName} ${r.variantSize} dikosongkan` : `PAR ${r.productName} ${r.variantSize} disimpan: ${parsed.value}`,
        tone: 'ok',
      })
      await sq.refetch()
    } catch (err) {
      setParErr(err instanceof Error ? err.message : 'Gagal menyimpan PAR.')
      input.value = r.parLevel == null ? '' : String(r.parLevel)
    }
  }

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
              Tambah barang masuk
            </Button>
          </>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
        <input
          type="text"
          placeholder="Cari produk / SKU..."
          aria-label="Cari produk atau SKU"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${fieldClass} pl-9`}
        />
      </div>

      {parErr && <p role="alert" className="text-sm text-red-600">{parErr}</p>}

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
                          key={`${rowKey(r.productId, r.variantSize)}|${r.parLevel ?? ''}`}
                          type="number"
                          min={0}
                          step={1}
                          defaultValue={r.parLevel ?? ''}
                          placeholder="—"
                          aria-label="PAR level stok"
                          onBlur={(e) => void savePar(r, e.currentTarget)}
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
                          Penyesuaian
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

      <GoodsInSlideOver
        open={giOpen}
        location={location}
        rows={rows}
        onClose={() => setGiOpen(false)}
        onDone={() => sq.refetch()}
      />

      {adjRow && (
        <AdjustSlideOver
          location={location}
          row={adjRow}
          onClose={() => setAdjRow(null)}
          onDone={() => sq.refetch()}
        />
      )}
    </div>
  )
}
