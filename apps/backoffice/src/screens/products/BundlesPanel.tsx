import type { Bundle } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Package } from 'lucide-react'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { BRAND } from '../../lib/brand'

interface BundlesPanelProps {
  bundles: Bundle[]
  loading?: boolean
  error?: string | null
  onRetry?: () => void
}

/** Item line "Melati 30ml ×2"; a single-unit product has no size to show. */
const itemText = (it: Bundle['items'][number]): string =>
  [it.productName, variantLabel(it.variantSize)].filter(Boolean).join(' ') + ` ×${it.quantity}`

export function BundlesPanel({ bundles, loading, error, onRetry }: BundlesPanelProps) {
  const columns: Column<Bundle>[] = [
    { id: 'name', header: 'Bundle', cell: (b) => <span className="font-bold text-ink-900">{b.name}</span> },
    {
      id: 'items',
      header: 'Isi',
      cell: (b) => (
        <div className="flex flex-wrap gap-1">
          {b.items.map((it) => <Badge key={`${it.productId}|${it.variantSize}`} tone="neutral">{itemText(it)}</Badge>)}
        </div>
      ),
    },
    { id: 'price', header: 'Harga', align: 'right', cell: (b) => <span className="font-bold text-brand-strong">{BRAND.currency.format(b.price)}</span> },
    { id: 'status', header: 'Status', cell: (b) => <Badge tone={b.isActive ? 'success' : 'neutral'}>{b.isActive ? 'Aktif' : 'Nonaktif'}</Badge> },
  ]
  return (
    <div className="space-y-3">
      <div className="bg-paper-1 border border-paper-2 rounded-xl p-3 text-xs text-ink-700">
        Bundle dikelola read-only dari katalog. Editor bundle menyusul.
      </div>
      <DataTable
        caption="Daftar bundle"
        columns={columns}
        rows={bundles}
        rowKey={(b) => b.id}
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={<EmptyState icon={<Package />} title="Belum ada bundle" />}
      />
    </div>
  )
}
