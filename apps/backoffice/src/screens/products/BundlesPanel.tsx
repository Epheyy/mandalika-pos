import type { Bundle } from '@mandalika/api'
import { Package } from 'lucide-react'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { BRAND } from '../../lib/brand'

interface BundlesPanelProps {
  bundles: Bundle[]
}

export function BundlesPanel({ bundles }: BundlesPanelProps) {
  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
        Bundle dikelola read-only dari katalog. Editor bundle menyusul.
      </div>
      {bundles.length === 0 ? (
        <Card>
          <EmptyState icon={<Package />} title="Belum ada bundle" />
        </Card>
      ) : bundles.map((b) => (
        <Card key={b.id} className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-black text-gray-900">{b.name}</p>
              <p className="text-sm text-gold-600 font-bold">{BRAND.currency.format(b.price)}</p>
              <p className="text-xs text-gray-400 mt-1">{b.items.length} item</p>
            </div>
            <Badge tone={b.isActive ? 'success' : 'neutral'}>{b.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {b.items.map((it) => (
              <Badge key={`${it.productId}|${it.variantSize}`} tone="neutral">{it.productName} {it.variantSize} ×{it.quantity}</Badge>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
