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
/** Mock row height (BO1-14). */
const ROW_HEIGHT = 52
// BO1-15: the row switch is read-only (status changes in the editor), but it must not look disabled: keep it full colour.
const READ_ONLY_SWITCH = 'disabled:opacity-100! disabled:cursor-default!'
const ERP_LOCK_REASON = 'Produk dari ERP tidak bisa dihapus; nonaktifkan saja'

/** A single-unit product carries the internal "Satuan" size: it shows as "Stok", never as a variant name. */
const stockBadgeLabel = (size: string): string => (variantLabel(size) ? `${variantLabel(size)}: ` : 'Stok: ')

export function ProductsTable({ rows, catName, loading, error, onRetry, selectedId, onEdit, onDelete, filtered, footer }: ProductsTableProps) {
  const columns: Column<Product>[] = [
    {
      id: 'product',
      header: 'Produk',
      cell: (p) => (
        <div className="flex items-center gap-3 whitespace-nowrap">
          <div className="w-8 h-8 rounded-lg bg-paper-1 overflow-hidden flex-shrink-0 flex items-center justify-center">
            {p.imageUrl ? <img src={p.imageUrl} alt="" className="w-full h-full object-cover" /> : <Package className="w-4 h-4 text-ink-500" aria-hidden="true" />}
          </div>
          <div>
            <p className="font-bold text-ink-900 text-sm">{p.name}</p>
            <p className="text-xs text-ink-700">{p.brand}</p>
          </div>
        </div>
      ),
    },
    { id: 'category', header: 'Kategori', cell: (p) => <span className="text-sm text-ink-900 whitespace-nowrap">{catName(p.categoryId)}</span> },
    {
      id: 'stock',
      header: 'Varian & Stok',
      cell: (p) => (
        <div className="flex gap-1 whitespace-nowrap">
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
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          {/* Read-only here: the status is changed inside the editor, where the whole product is saved at once. */}
          <Switch checked={p.isActive} onChange={noop} disabled size="sm" label={`Status ${p.name}`} className={READ_ONLY_SWITCH} />
          {/* M-8: the switch plus one state word; the source (ERP / internal) is a small neutral tag, never a second status. */}
          <span className="text-xs font-bold text-ink-700">{p.isActive ? 'Aktif' : 'Nonaktif'}</span>
          {p.erpLinked && <Badge tone="neutral" className="px-1.5! py-0.5! text-[11px]!">Dari ERP</Badge>}
          {p.erpLinked && <span id={`erp-nodelete-${p.id}`} className="sr-only">{ERP_LOCK_REASON}</span>}
          {p.sellable === false && <Badge tone="neutral" className="px-1.5! py-0.5! text-[11px]!">Internal</Badge>}
        </div>
      ),
    },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton label={`Ubah ${p.name}`} onClick={() => onEdit(p)}><Edit2 className="w-4 h-4" /></IconButton>
          <IconButton
            tone="danger"
            disabled={p.erpLinked === true}
            label={`Hapus ${p.name}`}
            aria-describedby={p.erpLinked ? `erp-nodelete-${p.id}` : undefined}
            title={p.erpLinked ? ERP_LOCK_REASON : undefined}
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
      rowHeight={ROW_HEIGHT}
      columnPrefsKey="bo.products.columns"
      empty={<EmptyState icon={<Package />} title={filtered ? 'Tidak ada produk yang cocok' : 'Belum ada produk'} subtitle={filtered ? 'Ubah atau atur ulang filter.' : undefined} />}
      footer={footer}
    />
  )
}
