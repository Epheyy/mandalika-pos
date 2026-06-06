import { useEffect, useState } from 'react'
import type { Ingredient, IngredientCategory, ListResult } from '@mandalika/api'
import { Edit2, Search, FlaskConical, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { TableSkeleton } from '../../components/Skeleton'
import { Button, Badge, EmptyState, Pagination, fieldClass } from '../../ui'
import { IngredientFormModal } from './IngredientFormModal'
import { DeleteIngredientModal } from './DeleteIngredientModal'


const formatIDR = (n: number | null | undefined) => {
  if (n == null) return '—'
  return n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
}

export default function DaftarTab() {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Ingredient | null>(null)
  const [deleting, setDeleting] = useState<Ingredient | null>(null)
  const [categories, setCategories] = useState<IngredientCategory[]>([])

  const q = usePolledQuery<ListResult<Ingredient>>(
    () => api.listIngredients({ page, limit: pageSize, ...(search.trim() ? { q: search.trim() } : {}) }),
    [page, pageSize, search],
  )
  const ingredients = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Fetch categories for the filter dropdown
  useEffect(() => {
    let alive = true
    api
      .listIngredientCategories()
      .then((cats) => { if (alive) setCategories(cats) })
      .catch(() => { /* non-fatal */ })
    return () => { alive = false }
  }, [])

  // Client-side category filter (category is not a server-side filter param)
  const filtered = categoryFilter
    ? ingredients.filter((i) => i.categoryId === categoryFilter)
    : ingredients

  const openAdd = () => {
    setEditing(null)
    setShowModal(true)
  }

  const openEdit = (ingredient: Ingredient) => {
    setEditing(ingredient)
    setShowModal(true)
  }

  const closeModal = () => setShowModal(false)

  const handleSearchChange = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const handleCategoryChange = (value: string) => {
    setCategoryFilter(value)
    setPage(1)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative max-w-xs w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Cari nama atau SKU..."
              className={`${fieldClass} pl-9`}
            />
          </div>

          {/* Category filter */}
          <select
            value={categoryFilter}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className={fieldClass + ' w-auto py-2'}
          >
            <option value="">Semua kategori</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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
          title={search || categoryFilter ? 'Tidak ditemukan' : 'Belum ada bahan'}
          subtitle={search || categoryFilter ? 'Coba kata kunci atau filter lain.' : 'Tambah bahan pertama untuk memulai.'}
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
                  SKU
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Satuan
                </th>
                <th className="px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-widest">
                  Kategori
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
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{ing.sku || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{ing.unit}</td>
                  <td className="px-4 py-3 text-gray-500">{ing.categoryName ?? '—'}</td>
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
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(ing)}
                        className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gold-600 transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setDeleting(ing)}
                        className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-red-600 transition-colors"
                        title="Hapus"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1) }}
        className="mt-4"
      />

      {/* Edit modal */}
      {showModal && (
        <IngredientFormModal
          editing={editing}
          onClose={closeModal}
          onDone={q.refetch}
        />
      )}

      {/* Delete modal */}
      {deleting && (
        <DeleteIngredientModal
          ingredient={deleting}
          onClose={() => setDeleting(null)}
          onDone={q.refetch}
        />
      )}
    </div>
  )
}
