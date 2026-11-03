import type { ReactNode } from 'react'
import type { Category } from '@mandalika/api'
import { Plus } from 'lucide-react'
import { buildExportName, exportToCSV } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { ExportButton } from '../../ui/ExportButton'
import { PageHeader } from '../../ui/PageHeader'
import { CategoriesTable } from './CategoriesTable'
import { CategoryFormModal } from './CategoryFormModal'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import { useCategoryCounts, useCategoryManager } from './useCategories'

interface CategoriesViewProps {
  categories: Category[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  tabs: ReactNode
}

export function CategoriesView({ categories, loading, error, refetch, tabs }: CategoriesViewProps) {
  const manager = useCategoryManager(refetch)
  const counts = useCategoryCounts(categories)

  const exportCategories = () =>
    exportToCSV(
      categories.map((c) => ({ Nama: c.name, Deskripsi: c.description || '', Urutan: c.sortOrder || 0 })),
      buildExportName('kategori', []),
    )

  return (
    <>
      <PageHeader
        title="Produk"
        count={loading ? undefined : `${categories.length} kategori`}
        subtitle="Kelompok untuk mengurutkan dan menyaring produk."
        actions={
          <>
            {tabs}
            <ExportButton rowCount={categories.length} filterSummary={[]} onExport={exportCategories} disabled={categories.length === 0} />
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={manager.openNew}>
              Tambah
            </Button>
          </>
        }
      />
      <CategoriesTable
        categories={categories}
        counts={counts}
        loading={loading && categories.length === 0}
        error={error ? 'Kategori gagal dimuat.' : null}
        onRetry={() => void refetch()}
        onEdit={manager.openEdit}
        onDelete={manager.askDelete}
      />
      <CategoryFormModal
        open={manager.open}
        editingCat={manager.editing}
        catForm={manager.form}
        setCatForm={manager.setForm}
        busy={manager.busy}
        error={manager.err}
        onSave={() => void manager.save()}
        onClose={manager.close}
      />
      <DeleteConfirmDialog
        open={manager.deleting !== null}
        subject={manager.deleting ? `kategori "${manager.deleting.name}"` : 'kategori'}
        error={manager.delErr}
        busy={manager.delBusy}
        onConfirm={() => void manager.confirmDelete()}
        onCancel={manager.cancelDelete}
      />
    </>
  )
}
