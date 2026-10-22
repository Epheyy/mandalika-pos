import type { Product, Category } from '@mandalika/api'
import { Edit2, Trash2, Package, Search } from 'lucide-react'
import { fieldClass } from '../../ui/Field'
import { Card } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'
import { TableSkeleton } from '../../components/Skeleton'

interface ProductsTableProps {
  loading: boolean
  filtered: Product[]
  categories: Category[]
  search: string
  setSearch: (v: string) => void
  fCat: string
  setFCat: (v: string) => void
  catName: (cid: string) => string
  onEdit: (p: Product) => void
  onDelete: (id: string) => void
}

export function ProductsTable({
  loading, filtered, categories, search, setSearch, fCat, setFCat, catName, onEdit, onDelete,
}: ProductsTableProps) {
  return (
    <>
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
          <input type="text" aria-label="Cari produk" placeholder="Cari produk..." value={search} onChange={(e) => setSearch(e.target.value)} className={`${fieldClass} pl-9`} />
        </div>
        <select value={fCat} onChange={(e) => setFCat(e.target.value)} className={`${fieldClass} w-auto`} aria-label="Filter kategori">
          <option value="">Semua Kategori</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <Card className="overflow-hidden">
        {loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<Package />} title="Tidak ada produk" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  {['Produk', 'Kategori', 'Varian & Stok', 'Status', 'Aksi'].map((h) => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                          {p.imageUrl ? <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-gray-300" />}
                        </div>
                        <div>
                          <p className="font-bold text-gray-900 text-sm">{p.name}</p>
                          <p className="text-xs text-gray-400">{p.brand}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3"><Badge tone="gold">{catName(p.categoryId)}</Badge></td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {p.variants.map((v) => (
                          <Badge key={v.size} tone={v.stock <= 5 ? 'danger' : 'neutral'}>{v.size}: {v.stock}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                        {p.erpLinked && <Badge tone="gold">Dari ERP</Badge>}
                        {p.erpLinked && <span id={`erp-nodelete-${p.id}`} className="sr-only">Produk dari ERP tidak bisa dihapus; nonaktifkan saja</span>}
                        {p.sellable === false && <Badge tone="warning">Internal</Badge>}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton onClick={() => onEdit(p)}><Edit2 className="w-4 h-4" /></IconButton>
                        <IconButton tone="danger" disabled={p.erpLinked === true} aria-label={`Hapus ${p.name}`}
                          aria-describedby={p.erpLinked ? `erp-nodelete-${p.id}` : undefined}
                          title={p.erpLinked ? 'Produk dari ERP tidak bisa dihapus; nonaktifkan saja' : undefined}
                          className="disabled:opacity-40 disabled:cursor-not-allowed" onClick={() => onDelete(p.id)}><Trash2 className="w-4 h-4" /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
