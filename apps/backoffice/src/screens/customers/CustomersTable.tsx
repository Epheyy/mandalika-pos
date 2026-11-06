import type { ReactNode } from 'react'
import type { Customer } from '@mandalika/api'
import { Edit2, Mail, Phone, Star, Trash2, Users } from 'lucide-react'
import { BRAND } from '../../lib/brand'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { IconButton } from '../../ui/IconButton'
import { tagChipClasses } from './tagColors'

interface CustomersTableProps {
  rows: readonly Customer[]
  loading: boolean
  error?: string | null
  onRetry?: () => void
  /** The Poin column only shows while the loyalty system is on. */
  showPoints: boolean
  /** True when search or filters narrow the list: the empty state then says so. */
  filtered: boolean
  /** The search text; the empty state quotes it. */
  query?: string
  /** The customer whose edit panel is open (row tint). */
  selectedId?: string | null
  onOpen: (c: Customer) => void
  onEdit: (c: Customer) => void
  onDelete: (c: Customer) => void
  footer?: ReactNode
}

export function CustomersTable({ rows, loading, error, onRetry, showPoints, filtered, query, selectedId, onOpen, onEdit, onDelete, footer }: CustomersTableProps) {
  const columns: Column<Customer>[] = [
    {
      id: 'customer',
      width: 260,
      header: 'Pelanggan',
      cell: (c) => (
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-paper-1 flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <span className="text-sm font-black text-brand-strong">{c.name.charAt(0).toUpperCase()}</span>
          </div>
          <div>
            <p className="font-bold text-ink-900 text-sm">{c.name}</p>
            <p className="text-xs text-ink-500">{c.visitCount} kunjungan</p>
            {(c.tags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {(c.tags ?? []).slice(0, 3).map((t) => (
                  <span key={t.id} className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${tagChipClasses(t.color)}`}>{t.name}</span>
                ))}
                {(c.tags ?? []).length > 3 && <span className="text-[10px] text-ink-500">+{(c.tags ?? []).length - 3}</span>}
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'contact',
      width: 220,
      header: 'Kontak',
      cell: (c) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-500"><Phone className="w-3 h-3" aria-hidden="true" /> {c.phone}</div>
          {c.email && <div className="flex items-center gap-1.5 text-xs text-ink-500"><Mail className="w-3 h-3" aria-hidden="true" /> {c.email}</div>}
        </div>
      ),
    },
    {
      id: 'spent',
      width: 150,
      header: 'Total Belanja',
      cell: (c) => <span className="font-black text-ink-900 text-sm">{BRAND.currency.format(c.totalSpent)}</span>,
    },
    ...(showPoints
      ? [{
          id: 'points',
          width: 100,
          header: 'Poin',
          cell: (c: Customer) => (
            <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-strong"><Star className="w-3.5 h-3.5" aria-hidden="true" />{c.points.toLocaleString('id-ID')}</span>
          ),
        } satisfies Column<Customer>]
      : []),
    {
      id: 'segment',
      width: 150,
      header: 'Segmen',
      cell: (c) =>
        c.segment
          ? <span className={`px-2.5 py-1 text-xs font-bold rounded-full border ${tagChipClasses(c.segment.color)}`}>{c.segment.name}</span>
          : <span className="text-xs text-ink-500">—</span>,
    },
    {
      id: 'actions',
      width: 110,
      header: 'Aksi',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton label={`Ubah ${c.name}`} onClick={() => onEdit(c)}><Edit2 className="w-4 h-4" /></IconButton>
          <IconButton tone="danger" label={`Hapus ${c.name}`} onClick={() => onDelete(c)}><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      caption="Daftar pelanggan"
      columns={columns}
      rows={rows}
      rowKey={(c) => c.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      onRowClick={onOpen}
      selectedKey={selectedId}
      columnPrefsKey="bo.customers.columns"
      empty={<EmptyState icon={<Users />} title={query ? `Tidak ada yang cocok dengan '${query}'` : filtered ? 'Tidak ada pelanggan yang cocok' : 'Belum ada pelanggan'} subtitle={filtered ? 'Ubah atau atur ulang filter.' : undefined} />}
      footer={footer}
    />
  )
}
