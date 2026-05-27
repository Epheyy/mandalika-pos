import { useState } from 'react'
import type { Ingredient } from '@mandalika/api'
import { Edit2, Search, FlaskConical } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button, Badge, EmptyState } from '../../ui'
import { IngredientFormModal } from './IngredientFormModal'

const formatIDR = (n: number | null | undefined) => {
  if (n == null) return '—'
  return n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
}

export default function DaftarTab() {
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Ingredient | null>(null)

  const q = usePolledQuery<Ingredient[]>(
    () => api.listIngredients({ limit: 100 }).then((r) => r.data),
    [],
  )
  const ingredients = q.data ?? []

  const filtered = ingredients.filter(
    (i) =>
      search.trim() === '' ||
      i.name.toLowerCase().includes(search.toLowerCase()),
  )

  const openAdd = () => {
    setEditing(null)
    setShowModal(true)
  }

  const openEdit = (ingredient: Ingredient) => {
    setEditing(ingredient)
    setShowModal(true)
  }

  const closeModal = () => setShowModal(false)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <div className="relative max-w-xs w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari bahan..."
            className="w-full pl-9 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400 transition"
          />
        </div>
        <Button onClick={openAdd}>+ Tambah Bahan</Button>
      </div>

      {/* Table */}
      {q.loading ? (
        <TableSkeleton rows={5} />
      ) : q.error ? (
        <p className="text-sm text-red-600 p-4">{q.error}</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FlaskConical />}
          title={search ? 'Tidak ditemukan' : 'Belum ada bahan'}
          subtitle={search ? 'Coba kata kunci lain.' : 'Tambah bahan pertama untuk memulai.'}
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Nama
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Satuan
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest text-right">
                  Biaya Default
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Catatan
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Status
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((ing) => (
                <tr key={ing.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{ing.name}</td>
                  <td className="px-4 py-3 text-gray-600">{ing.unit}</td>
                  <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                    {formatIDR(ing.defaultUnitCost)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">
                    {ing.notes ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={ing.isActive ? 'success' : 'neutral'}>
                      {ing.isActive ? 'Aktif' : 'Nonaktif'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => openEdit(ing)}
                      className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gold-600 transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <IngredientFormModal
          editing={editing}
          onClose={closeModal}
          onDone={q.refetch}
        />
      )}
    </div>
  )
}
