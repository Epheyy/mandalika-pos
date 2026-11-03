import type { ReactNode } from 'react'
import type { DiscountCode, Promotion } from '@mandalika/api'
import { Copy, Edit2, Tag, Trash2 } from 'lucide-react'
import { BRAND } from '../../lib/brand'
import { PROMOTION_STATUS } from '../../lib/labels'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { IconButton } from '../../ui/IconButton'
import { StatusBadge } from '../../ui/StatusBadge'
import { Switch } from '../../ui/Switch'
import { codeValueLabel } from './promoDisplay'
import { promoStatus } from './promoStatus'

interface CodesTableProps {
  rows: readonly DiscountCode[]
  /** Every promotion, to name a code's linked promotion (the list page only holds codes). */
  promotions: readonly Promotion[]
  today: string
  loading: boolean
  error?: string | null
  onRetry?: () => void
  selectedId?: string | null
  filtered?: boolean
  busyId?: string | null
  onToggle: (c: DiscountCode, next: boolean) => void
  onEdit: (c: DiscountCode) => void
  onCopy: (c: DiscountCode) => void
  onDelete: (c: DiscountCode) => void
  footer?: ReactNode
}

export function CodesTable({ rows, promotions, today, loading, error, onRetry, selectedId, filtered, busyId, onToggle, onEdit, onCopy, onDelete, footer }: CodesTableProps) {
  const columns: Column<DiscountCode>[] = [
    {
      id: 'code',
      header: 'Kode',
      cell: (c) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-gold-50 px-3 py-1 text-sm font-black tracking-wider text-gold-700">{c.code}</span>
            <IconButton aria-label={`Salin ${c.code}`} onClick={() => onCopy(c)} className="p-1"><Copy className="h-3.5 w-3.5" /></IconButton>
          </div>
          {c.combinable && <Badge tone="gold" className="mt-0.5 inline-block">Bisa Kombinasi</Badge>}
          {c.promotionId && <p className="mt-0.5 text-xs text-gray-500">Tertaut: {promotions.find((p) => p.id === c.promotionId)?.name ?? c.promotionId}</p>}
          {c.customerId && <p className="mt-0.5 text-xs text-gray-500">Khusus: {c.customerName ?? '—'}</p>}
        </div>
      ),
    },
    { id: 'value', header: 'Diskon', cell: (c) => <span className="text-sm font-bold text-gray-900">{codeValueLabel(c)}</span> },
    { id: 'min', header: 'Min. Beli', cell: (c) => <span className="text-sm text-gray-600">{c.minPurchase ? BRAND.currency.format(c.minPurchase) : '—'}</span> },
    { id: 'usage', header: 'Penggunaan', cell: (c) => <span className="text-sm font-bold text-gray-900">{c.usageCount} / {c.usageLimit || '∞'}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (c) => (
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Switch size="sm" checked={c.isActive} disabled={busyId === c.id} label={`Status ${c.code}`} onChange={(next) => onToggle(c, next)} />
          <StatusBadge map={PROMOTION_STATUS} value={promoStatus(c, today)} />
        </div>
      ),
    },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton aria-label={`Ubah ${c.code}`} onClick={() => onEdit(c)}><Edit2 className="h-4 w-4" /></IconButton>
          <IconButton tone="danger" aria-label={`Hapus ${c.code}`} onClick={() => onDelete(c)}><Trash2 className="h-4 w-4" /></IconButton>
        </div>
      ),
    },
  ]
  return (
    <DataTable
      caption="Daftar kode diskon"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      selectedKey={selectedId}
      empty={<EmptyState icon={<Tag />} title={filtered ? 'Tidak ada kode yang cocok' : 'Belum ada kode diskon'} subtitle={filtered ? 'Ubah atau atur ulang filter.' : undefined} />}
      footer={footer}
    />
  )
}
