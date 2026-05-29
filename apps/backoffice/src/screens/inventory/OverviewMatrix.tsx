import type { InventoryOverviewLocation } from '@mandalika/api'
import { Package, Store, Warehouse as WarehouseIcon } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Card, EmptyState } from '../../ui'

interface LocationTarget {
  kind: 'outlet' | 'warehouse'
  id: string
  name: string
}

interface OverviewMatrixProps {
  onPickLocation: (loc: LocationTarget) => void
}

function LocationIcon({ kind }: { kind: 'outlet' | 'warehouse' }) {
  return kind === 'outlet' ? (
    <Store className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" />
  ) : (
    <WarehouseIcon className="w-3.5 h-3.5 text-gold-600 flex-shrink-0" />
  )
}

function LocationHeaderButton({
  loc,
  onClick,
}: {
  loc: InventoryOverviewLocation
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 px-2 py-1 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors min-w-[80px]"
      title={`Lihat stok ${loc.name}`}
    >
      <LocationIcon kind={loc.kind} />
      <span className="text-xs font-bold text-gray-700 whitespace-nowrap leading-tight">
        {loc.name}
      </span>
    </button>
  )
}

export function OverviewMatrix({ onPickLocation }: OverviewMatrixProps) {
  const q = usePolledQuery(() => api.getInventoryOverview(), [])
  const data = q.data

  return (
    <Card className="overflow-hidden">
      {q.loading && !data ? (
        <TableSkeleton />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState icon={<Package />} title="Belum ada data stok" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                {/* Sticky first column: Varian */}
                <th className="sticky left-0 bg-gray-50 z-10 text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap border-r border-gray-100">
                  Varian
                </th>
                {data.locations.map((loc) => (
                  <th
                    key={loc.id}
                    className="px-2 py-2 text-xs font-black text-gray-400 uppercase tracking-wider text-center"
                  >
                    <LocationHeaderButton
                      loc={loc}
                      onClick={() =>
                        onPickLocation({ kind: loc.kind, id: loc.id, name: loc.name })
                      }
                    />
                  </th>
                ))}
                {/* Total column */}
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider text-right whitespace-nowrap border-l border-gray-100">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.rows.map((row) => (
                <tr key={`${row.productId}|${row.variantSize}`} className="hover:bg-gray-50">
                  {/* Sticky first column */}
                  <td className="sticky left-0 bg-white z-10 px-5 py-3 font-bold text-gray-900 text-sm whitespace-nowrap border-r border-gray-100">
                    {row.productName}{' '}
                    <span className="font-normal text-gray-500">{row.variantSize}</span>
                    {row.sku && (
                      <span className="ml-1 font-mono text-xs text-gray-400">· {row.sku}</span>
                    )}
                  </td>
                  {data.locations.map((loc) => {
                    const cell = row.cells.find((c) => c.locationId === loc.id)
                    const stock = cell?.stock ?? 0
                    const low = cell?.belowPar === true
                    return (
                      <td
                        key={loc.id}
                        className={`px-4 py-3 text-center text-sm ${
                          low ? 'text-red-600 font-bold' : 'text-gray-700'
                        }`}
                      >
                        {stock}
                      </td>
                    )
                  })}
                  {/* Total */}
                  <td className="px-4 py-3 text-right font-bold text-gray-900 text-sm border-l border-gray-100">
                    {row.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
