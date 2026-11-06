import type { Category } from '@mandalika/api'
import { Edit2, Trash2, Tag } from 'lucide-react'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { IconButton } from '../../ui/IconButton'

interface CategoriesTableProps {
  categories: Category[]
  /** Products per category id; missing or null = not known (shown as a dash). */
  counts: Readonly<Record<string, number | null>>
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onEdit: (c: Category) => void
  onDelete: (c: Category) => void
}

export function CategoriesTable({ categories, counts, loading, error, onRetry, onEdit, onDelete }: CategoriesTableProps) {
  const columns: Column<Category>[] = [
    { id: 'name', header: 'Nama', cell: (c) => <span className="font-bold text-ink-900">{c.name}</span> },
    { id: 'description', header: 'Deskripsi', cell: (c) => <span className="text-sm text-ink-700">{c.description || '—'}</span> },
    { id: 'count', header: 'Jumlah Produk', align: 'right', cell: (c) => <span className="text-sm font-bold text-brand-strong">{counts[c.id] ?? '—'}</span> },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1">
          <IconButton label={`Ubah ${c.name}`} onClick={() => onEdit(c)}><Edit2 className="w-4 h-4" /></IconButton>
          <IconButton tone="danger" label={`Hapus ${c.name}`} onClick={() => onDelete(c)}><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      ),
    },
  ]
  return (
    <DataTable
      caption="Daftar kategori produk"
      columns={columns}
      rows={categories}
      rowKey={(c) => c.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={<EmptyState icon={<Tag />} title="Belum ada kategori" />}
    />
  )
}
