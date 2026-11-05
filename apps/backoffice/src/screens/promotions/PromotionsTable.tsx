import type { ReactNode } from 'react'
import type { Promotion } from '@mandalika/api'
import { Copy, Edit2, Tag, Trash2 } from 'lucide-react'
import { PROMOTION_STATUS, PROMOTION_TYPE } from '../../lib/labels'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { IconButton } from '../../ui/IconButton'
import { StatusBadge } from '../../ui/StatusBadge'
import { Switch } from '../../ui/Switch'
import { periodText, promoValueLabel } from './promoDisplay'
import { promoStatus } from './promoStatus'

interface PromotionsTableProps {
  rows: readonly Promotion[]
  /** The business day (WIB) the status badges are derived from. */
  today: string
  loading: boolean
  error?: string | null
  onRetry?: () => void
  selectedId?: string | null
  filtered?: boolean
  /** Promotions whose status change is in flight (their Switch is off for the moment). */
  busyIds?: ReadonlySet<string>
  onToggle: (p: Promotion, next: boolean) => void
  onEdit: (p: Promotion) => void
  onDuplicate: (p: Promotion) => void
  onDelete: (p: Promotion) => void
  footer?: ReactNode
}

export function PromotionsTable({ rows, today, loading, error, onRetry, selectedId, filtered, busyIds, onToggle, onEdit, onDuplicate, onDelete, footer }: PromotionsTableProps) {
  const columns: Column<Promotion>[] = [
    {
      id: 'name',
      header: 'Promosi',
      cell: (p) => (
        <div>
          <p className="text-sm font-bold text-gray-900">{p.name}</p>
          {p.description && <p className="text-xs text-gray-400">{p.description}</p>}
          <div className="mt-0.5 flex flex-wrap gap-1">
            {p.combinable && <Badge tone="gold">Bisa Kombinasi</Badge>}
            {p.autoApply && <Badge tone="neutral">Otomatis</Badge>}
            {p.codeOnly && <Badge tone="gold">Hanya kode</Badge>}
          </div>
        </div>
      ),
    },
    { id: 'type', header: 'Jenis', cell: (p) => <StatusBadge map={PROMOTION_TYPE} value={p.type} /> },
    { id: 'value', header: 'Nilai', cell: (p) => <span className="text-sm font-bold text-gray-900">{promoValueLabel(p)}</span> },
    { id: 'period', header: 'Periode', cell: (p) => <span className="text-xs text-gray-500">{periodText(p.startDate, p.endDate)}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (p) => (
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Switch size="sm" checked={p.isActive} disabled={busyIds?.has(p.id)} label={`Status ${p.name}`} onChange={(next) => onToggle(p, next)} />
          <StatusBadge map={PROMOTION_STATUS} value={promoStatus(p, today)} />
        </div>
      ),
    },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton aria-label={`Ubah ${p.name}`} onClick={() => onEdit(p)}><Edit2 className="h-4 w-4" /></IconButton>
          <IconButton aria-label={`Duplikat ${p.name}`} title="Duplikat" onClick={() => onDuplicate(p)}><Copy className="h-4 w-4" /></IconButton>
          <IconButton tone="danger" aria-label={`Hapus ${p.name}`} onClick={() => onDelete(p)}><Trash2 className="h-4 w-4" /></IconButton>
        </div>
      ),
    },
  ]
  return (
    <DataTable
      caption="Daftar promosi"
      columns={columns}
      rows={rows}
      rowKey={(p) => p.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      selectedKey={selectedId}
      empty={<EmptyState icon={<Tag />} title={filtered ? 'Tidak ada promosi yang cocok' : 'Belum ada promosi'} subtitle={filtered ? 'Ubah atau atur ulang filter.' : undefined} />}
      footer={footer}
    />
  )
}
