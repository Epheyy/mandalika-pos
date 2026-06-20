import { useState } from 'react'
import type { IngredientStockRow } from '@mandalika/api'
import { ArrowLeft, Layers, PackagePlus, SlidersHorizontal } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { IngredientGoodsInModal } from './IngredientGoodsInModal'
import { IngredientAdjustModal } from './IngredientAdjustModal'

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

interface IngredientLocationStockViewProps {
  location: LocationTarget
  onBack: () => void
}

const formatQty = (n: number) =>
  n.toLocaleString('id-ID', { maximumFractionDigits: 3 })

export function IngredientLocationStockView({ location, onBack }: IngredientLocationStockViewProps) {
  const sq = usePolledQuery<IngredientStockRow[]>(
    () => api.getIngredientLocationStock(location.kind, location.id),
    [location.kind, location.id],
  )
  const rows = sq.data ?? []

  const [giOpen, setGiOpen] = useState(false)
  const [adjRow, setAdjRow] = useState<IngredientStockRow | null>(null)

  const subtitle =
    location.kind === 'outlet'
      ? `Stok outlet · ${rows.length} bahan`
      : `Stok gudang · ${rows.length} bahan`

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

      <Card className="overflow-hidden">
        {sq.loading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="Stok kosong"
            subtitle="Belum ada bahan di lokasi ini. Tambahkan stok melalui Barang Masuk."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Bahan', 'Satuan', 'Stok', 'Aksi'].map((h) => (
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
                {rows.map((r) => (
                  <tr key={r.ingredientId} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-bold text-gray-900 text-sm">{r.name}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{r.unit}</td>
                    <td className="px-5 py-3 text-sm tabular-nums text-gray-800">
                      {formatQty(r.qty)}
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

      {giOpen && (
        <IngredientGoodsInModal
          location={location}
          onClose={() => setGiOpen(false)}
          onDone={() => sq.refetch()}
        />
      )}

      {adjRow && (
        <IngredientAdjustModal
          location={location}
          ingredientId={adjRow.ingredientId}
          onClose={() => setAdjRow(null)}
          onDone={() => sq.refetch()}
        />
      )}
    </div>
  )
}
