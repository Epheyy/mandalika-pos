import type { Product, Category } from '@mandalika/api'
import { Edit2, Trash2, Tag } from 'lucide-react'
import { Card } from '../../ui/Card'
import { IconButton } from '../../ui/IconButton'
import { EmptyState } from '../../ui/EmptyState'

interface CategoriesTableProps {
  categories: Category[]
  products: Product[]
  onEdit: (c: Category) => void
  onDelete: (id: string) => void
}

export function CategoriesTable({ categories, products, onEdit, onDelete }: CategoriesTableProps) {
  return (
    <Card className="overflow-hidden">
      {categories.length === 0 ? (
        <EmptyState icon={<Tag />} title="Belum ada kategori" />
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              {['Nama', 'Deskripsi', 'Jumlah Produk', 'Aksi'].map((h) => <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {categories.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-bold text-gray-900">{c.name}</td>
                <td className="px-5 py-3 text-sm text-gray-500">{c.description || '—'}</td>
                <td className="px-5 py-3 text-sm font-bold text-gold-600">{products.filter((p) => p.categoryId === c.id).length}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton onClick={() => onEdit(c)}><Edit2 className="w-4 h-4" /></IconButton>
                    <IconButton tone="danger" onClick={() => onDelete(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
