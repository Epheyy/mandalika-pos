import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { IngredientCategory } from '@mandalika/api'
import { api } from '../../api'
import { Button } from '../../ui/Button'

interface ConfirmDeleteState {
  id: string
  name: string
}

interface CategoryManagerProps {
  categories: IngredientCategory[]
  selectedCategoryId: string
  onCategoriesChange: (updated: IngredientCategory[]) => void
  onCategoryDeleted: (deletedId: string) => void
}

/** Inline panel that lists existing categories with a delete affordance. */
export function CategoryManager({
  categories,
  selectedCategoryId,
  onCategoriesChange,
  onCategoryDeleted,
}: CategoryManagerProps) {
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return
    setDeleteBusy(true)
    setDeleteErr(null)
    try {
      await api.deleteIngredientCategory(confirmDelete.id)
      const updated = await api.listIngredientCategories()
      onCategoriesChange(updated)
      if (selectedCategoryId === confirmDelete.id) {
        onCategoryDeleted(confirmDelete.id)
      }
      setConfirmDelete(null)
    } catch (e: unknown) {
      setDeleteErr(e instanceof Error ? e.message : 'Gagal menghapus kategori.')
    } finally {
      setDeleteBusy(false)
    }
  }

  if (categories.length === 0) {
    return (
      <p className="text-[11px] text-gray-400 mt-2 italic">Belum ada kategori.</p>
    )
  }

  return (
    <div className="mt-2">
      <ul className="space-y-1">
        {categories.map((cat) => (
          <li
            key={cat.id}
            className="flex items-center justify-between px-2 py-1 rounded-lg bg-gray-50 group"
          >
            <span className="text-sm text-gray-700 truncate">{cat.name}</span>
            <button
              type="button"
              aria-label={`Hapus kategori ${cat.name}`}
              onClick={() => { setConfirmDelete({ id: cat.id, name: cat.name }); setDeleteErr(null) }}
              className="ml-2 p-1 rounded-lg text-gray-500 hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {/* Inline confirmation dialog */}
      {confirmDelete && (
        <div className="mt-2 p-3 rounded-xl border border-red-200 bg-red-50 space-y-2">
          <p className="text-xs text-gray-700">
            Hapus kategori <strong>&ldquo;{confirmDelete.name}&rdquo;</strong>? Bahan yang memakai
            kategori ini tetap ada (FK SET NULL).
          </p>
          {deleteErr && (
            <p className="text-[11px] text-red-600">{deleteErr}</p>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 text-xs py-1.5"
              onClick={() => { setConfirmDelete(null); setDeleteErr(null) }}
              disabled={deleteBusy}
            >
              Batal
            </Button>
            <Button
              variant="danger"
              className="flex-1 text-xs py-1.5"
              onClick={() => { void handleDeleteConfirm() }}
              loading={deleteBusy}
            >
              Hapus
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
