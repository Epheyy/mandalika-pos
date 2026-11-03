import type { ReactNode } from 'react'
import type { Product } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { Edit2, Trash2, Package } from 'lucide-react'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { EmptyState } from '../../ui/EmptyState'
import { IconButton } from '../../ui/IconButton'
import { Switch } from '../../ui/Switch'
import { stockLevel, stockText } from './productsListState'

interface ProductsTableProps {
  rows: readonly Product[]
  catName: (cid: string) => string
  loading: boolean
  error?: string | null
  onRetry?: () => void
  /** The product open in the editor (row tint). */
  selectedId?: string | null
  onEdit: (p: Product) => void
  onDelete: (p: Product) => void
  /** True when filters narrow the list: the empty state then says so. */
  filtered?: boolean
  footer?: ReactNode
}

const STOCK_TONE = { out: 'danger', low: 'warning', ok: 'neutral' } as const
const noop = () => {}

/** A single-unit product carries the internal "Satuan" size: it shows as "Stok", never as a variant name. */
const stockBadgeLabel = (size: string): string => (variantLabel(size) ? `${variantLabel(size)}: ` : 'Stok: ')

export function ProductsTable({ rows, catName, loading, error, onRetry, selectedId, onEdit, onDelete, filtered, footer }: ProductsTableProps) {
  const columns: Column<Product>[] = [
    {
      id: 'product',
      header: 'Produk',
      cell: (p) => (
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
            {p.imageUrl ? <img src={p.imageUrl} alt="" className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" aria-hidden="true" />}
          </div>
          <div>
            <p className="font-bold text-gray-900 text-sm">{p.name}</p>
            <p className="text-xs text-gray-400">{p.brand}</p>
          </div>
        </div>
      ),
    },
    { id: 'category', header: 'Kategori', cell: (p) => <Badge tone="gold">{catName(p.categoryId)}</Badge> },
    {
      id: 'stock',
      header: 'Varian & Stok',
      cell: (p) => (
        <div className="flex flex-wrap gap-1">
          {p.variants.map((v) => (
            <Badge key={v.size} tone={STOCK_TONE[stockLevel(v.stock)]}>
              {stockBadgeLabel(v.size)}
              {stockText(v.stock)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (p) => (
        <div className="flex flex-wrap items-center gap-1">
          {/* Read-only here: the status is changed inside the editor, where the whole product is saved at once. */}
          <Switch checked={p.isActive} onChange={noop} disabled size="sm" label={`Status ${p.name}`} />
          <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
          {p.erpLinked && <Badge tone="gold">Dari ERP</Badge>}
          {p.erpLinked && <span id={`erp-nodelete-${p.id}`} className="sr-only">Produk dari ERP tidak bisa dihapus; nonaktifkan saja</span>}
          {p.sellable === false && <Badge tone="warning">Internal</Badge>}
        </div>
      ),
    },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton aria-label={`Ubah ${p.name}`} onClick={() => onEdit(p)}><Edit2 className="w-4 h-4" /></IconButton>
          <IconButton
            tone="danger"
            disabled={p.erpLinked === true}
            aria-label={`Hapus ${p.name}`}
            aria-describedby={p.erpLinked ? `erp-nodelete-${p.id}` : undefined}
            title={p.erpLinked ? 'Produk dari ERP tidak bisa dihapus; nonaktifkan saja' : undefined}
            className="disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => onDelete(p)}
          >
            <Trash2 className="w-4 h-4" />
          </IconButton>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      caption="Daftar produk"
      columns={columns}
      rows={rows}
      rowKey={(p) => p.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      selectedKey={selectedId}
      empty={<EmptyState icon={<Package />} title={filtered ? 'Tidak ada produk yang cocok' : 'Belum ada produk'} subtitle={filtered ? 'Ubah atau atur ulang filter.' : undefined} />}
      footer={footer}
    />
  )
}
