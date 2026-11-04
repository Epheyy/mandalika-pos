import { useEffect, useState } from 'react'
import { fetchAllPages, type Ingredient, type IngredientCategory, type ListResult } from '@mandalika/api'
import { Edit2, FlaskConical, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { usePolledQuery } from '../../hooks/usePolledQuery'
import { ImportExportBar } from '../../components/ImportExportBar'
import { exportToCSV, exportToXLSX } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { DataTable, type Column } from '../../ui/DataTable'
import { IconButton } from '../../ui/IconButton'
import { Badge } from '../../ui/Badge'
import { EmptyState } from '../../ui/EmptyState'
import { Pagination } from '../../ui/Pagination'
import { IngredientFormModal } from './IngredientFormModal'
import { DeleteIngredientDialog } from './DeleteIngredientDialog'
import { useListState } from '../../lib/router/useListState'
import { FilterBar } from '../../ui/FilterBar'
import { DAFTAR_SCHEMA, bahanPageOf, bahanSizeOf, categoryOf } from './bahanRoute'


const formatIDR = (n: number | null | undefined) => {
  if (n == null) return '—'
  return n.toLocaleString('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
}

/** Every ingredient that matches the search and category on screen, not just the visible page. */
const exportIngredients = async (fmt: 'csv' | 'xlsx', filter: { q: string; categoryId: string }) => {
  const all = await fetchAllPages((page, limit) =>
    api.listIngredients({ page, limit, ...(filter.q ? { q: filter.q } : {}), ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) }),
  )
  const rows = all.map((i) => ({
    Nama: i.name,
    SKU: i.sku || '',
    Satuan: i.unit,
    Kategori: i.categoryName ?? '',
    'Biaya Default': i.defaultUnitCost ?? '',
    Catatan: i.notes ?? '',
    Status: i.isActive ? 'Aktif' : 'Nonaktif',
  }))
  if (!rows.length) return
  if (fmt === 'xlsx') exportToXLSX(rows, 'bahan_mandalika')
  else exportToCSV(rows, 'bahan_mandalika')
}

const downloadIngredientTemplate = () => {
  const example = [
    { Nama: 'Rose Oil', SKU: 'RO-001', Satuan: 'g', Kategori: 'Fragrance Oil', 'Biaya Default': 15000, Catatan: '', Status: 'Aktif' },
    { Nama: 'Contoh Bahan', SKU: '', Satuan: 'ml', Kategori: '', 'Biaya Default': '', Catatan: 'Bahan tanpa SKU dan kategori', Status: 'Aktif' },
  ]
  exportToCSV(example, 'template_bahan_mandalika')
}

export default function DaftarTab() {
  // Search, category, page and page size are in the URL (#/inventori/bahan/daftar?q=&kategori=&hal=&per=).
  const [state, setState] = useListState(DAFTAR_SCHEMA)
  const search = state.q
  const categoryFilter = categoryOf(state.kategori)
  const page = bahanPageOf(state.hal)
  const pageSize = bahanSizeOf(state.per)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Ingredient | null>(null)
  const [deleting, setDeleting] = useState<Ingredient | null>(null)
  const [categories, setCategories] = useState<IngredientCategory[]>([])
  // Without the list the select cannot name the category the URL asks for, so say so instead of showing "Semua kategori".
  const [categoriesErr, setCategoriesErr] = useState<string | null>(null)

  const q = usePolledQuery<ListResult<Ingredient>>(
    () => api.listIngredients({
      page,
      limit: pageSize,
      ...(search.trim() ? { q: search.trim() } : {}),
      ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    }),
    [page, pageSize, search, categoryFilter],
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
      .catch((e: unknown) => { if (alive) setCategoriesErr(e instanceof Error ? e.message : 'coba lagi.') })
    return () => { alive = false }
  }, [])

  const openAdd = () => {
    setEditing(null)
    setShowModal(true)
  }

  const openEdit = (ingredient: Ingredient) => {
    setEditing(ingredient)
    setShowModal(true)
  }

  const closeModal = () => setShowModal(false)

  const handleSearchChange = (value: string) => setState({ q: value, hal: 1 }, { replace: true })

  const handleCategoryChange = (value: string) => setState({ kategori: value, hal: 1 })

  const refetchAfterImport = () => {
    void Promise.all([q.refetch(), api.listIngredientCategories().then(setCategories)]).catch((e: unknown) =>
      setCategoriesErr(e instanceof Error ? e.message : 'coba lagi.'),
    )
  }

  const columns: Column<Ingredient>[] = [
    { id: 'name', header: 'Nama', cell: (ing) => <span className="font-medium text-gray-900">{ing.name}</span> },
    { id: 'sku', header: 'SKU', cell: (ing) => <span className="font-mono text-xs text-gray-500">{ing.sku || '—'}</span> },
    { id: 'unit', header: 'Satuan', cell: (ing) => <span className="text-gray-600">{ing.unit}</span> },
    { id: 'category', header: 'Kategori', cell: (ing) => <span className="text-gray-500">{ing.categoryName ?? '—'}</span> },
    { id: 'cost', header: 'Biaya Default', align: 'right', cell: (ing) => <span className="text-gray-700">{formatIDR(ing.defaultUnitCost)}</span> },
    { id: 'notes', header: 'Catatan', cell: (ing) => <span className="block max-w-[200px] truncate text-gray-500">{ing.notes ?? '—'}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: (ing) => <Badge tone={ing.isActive ? 'success' : 'neutral'}>{ing.isActive ? 'Aktif' : 'Nonaktif'}</Badge>,
    },
    {
      id: 'actions',
      header: 'Aksi',
      align: 'right',
      cell: (ing) => (
        <div className="flex items-center justify-end gap-1">
          <IconButton aria-label={`Ubah ${ing.name}`} title="Edit" onClick={() => openEdit(ing)}><Edit2 className="w-4 h-4" /></IconButton>
          <IconButton tone="danger" aria-label={`Hapus ${ing.name}`} title="Hapus" onClick={() => setDeleting(ing)}><Trash2 className="w-4 h-4" /></IconButton>
        </div>
      ),
    },
  ]

  const hasFilter = search !== '' || categoryFilter !== ''
  return (
    <div className="space-y-4">
      <FilterBar
        onReset={() => setState({ q: '', kategori: '', hal: 1 })}
        activeCount={[search !== '', categoryFilter !== ''].filter(Boolean).length}
        actions={
          <>
            <ImportExportBar
              onExport={(fmt) => exportIngredients(fmt, { q: search.trim(), categoryId: categoryFilter })}
              filterSummary={[...(search.trim() ? [`Cari: ${search.trim()}`] : []), ...(categoryFilter ? [`Kategori: ${categories.find((c) => c.id === categoryFilter)?.name ?? 'tidak dikenal'}`] : [])]}
              importKind="ingredients"
              onImported={refetchAfterImport}
              onTemplate={downloadIngredientTemplate}
            />
            <Button onClick={openAdd}>+ Tambah Bahan</Button>
          </>
        }
      >
        <FilterBar.Search label="Cari bahan" placeholder="Cari nama atau SKU..." value={search} onChange={handleSearchChange} />
        <FilterBar.Select
          label="Kategori"
          value={categoryFilter}
          onChange={handleCategoryChange}
          options={[{ value: '', label: 'Semua kategori' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
        />
      </FilterBar>

      {categoriesErr && (
        <p role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
          Daftar kategori gagal dimuat: {categoriesErr}
        </p>
      )}

      <DataTable
        caption="Daftar bahan"
        columns={columns}
        rows={ingredients}
        rowKey={(ing) => ing.id}
        loading={q.loading}
        error={q.error ? `Daftar bahan gagal dimuat: ${q.error}` : null}
        onRetry={() => void q.refetch()}
        empty={
          <EmptyState
            icon={<FlaskConical />}
            title={hasFilter ? 'Tidak ditemukan' : 'Belum ada bahan'}
            subtitle={hasFilter ? 'Coba kata kunci atau filter lain.' : 'Tambah bahan pertama untuk memulai.'}
          />
        }
        footer={
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            onChange={(hal) => setState({ hal })}
            pageSize={pageSize}
            onPageSizeChange={(per) => setState({ per, hal: 1 })}
          />
        }
      />

      {showModal && (
        <IngredientFormModal
          editing={editing}
          onClose={closeModal}
          onDone={q.refetch}
        />
      )}

      {deleting && (
        <DeleteIngredientDialog
          ingredient={deleting}
          onClose={() => setDeleting(null)}
          onDone={q.refetch}
        />
      )}
    </div>
  )
}
