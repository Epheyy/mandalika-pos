import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Category, Product } from '@mandalika/api'
import { Plus } from 'lucide-react'
import { api } from '../../api'
import { ImportExportBar } from '../../components/ImportExportBar'
import { exportToCSV } from '../../lib/csvUtils'
import { PRODUCT_TEMPLATE_ROWS } from '../../lib/importTemplates'
import { isUuidSegment } from '../../lib/router/tabs'
import { Button } from '../../ui/Button'
import { PageHeader } from '../../ui/PageHeader'
import { Pagination } from '../../ui/Pagination'
import { useToast } from '../../ui/Toast'
import { DeleteConfirmDialog } from './DeleteConfirmDialog'
import { ProductEditorHost } from './ProductEditorHost'
import { ProductsFilters } from './ProductsFilters'
import { ProductsTable } from './ProductsTable'
import { PRODUCT_PAGE_SIZES } from './productsListState'
import { useProductsList } from './useProductsList'

interface ProductsListViewProps {
  categories: Category[]
  refetchCategories: () => Promise<unknown>
  /** The Produk / Kategori / Bundle tab strip, shown in the header. */
  tabs: ReactNode
}

const downloadProductTemplate = () => exportToCSV(PRODUCT_TEMPLATE_ROWS, 'template_produk_mandalika')

/** A refused delete (409: stock on hand, or receipt/adjustment/transfer history) keeps the dialog open with the
 *  server's reason. busy blocks a second click, whose 404 would otherwise linger as the next dialog's error. */
function useProductDelete(refetch: () => Promise<unknown>) {
  const [target, setTarget] = useState<Product | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ask = (p: Product) => {
    setError(null)
    setTarget(p)
  }
  const cancel = () => {
    if (!busy) setTarget(null)
  }
  const confirm = async () => {
    if (!target) return
    setBusy(true)
    try {
      await api.deleteProduct(target.id)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal menghapus produk.')
      return
    } finally {
      setBusy(false)
    }
    setTarget(null)
    await refetch()
  }
  return { target, error, busy, ask, cancel, confirm }
}

export function ProductsListView({ categories, refetchCategories, tabs }: ProductsListViewProps) {
  const list = useProductsList(categories)
  const toast = useToast()
  const del = useProductDelete(list.refetch)
  const { state, setOverlay } = list
  const catName = (cid: string) => categories.find((c) => c.id === cid)?.name || '—'

  // The overlay is URL state: `?ubah=<id>` edits, `?baru=1` creates. An id that is not a record id never reaches the API.
  const editingId = isUuidSegment(state.ubah) ? state.ubah : null
  const badId = state.ubah !== '' && editingId === null
  const overlayOpen = editingId !== null || state.baru
  useEffect(() => {
    if (!badId) return
    toast({ message: 'Alamat produk tidak valid.', tone: 'warn' })
    setOverlay({ ubah: '' }, { replace: true })
  }, [badId, toast, setOverlay])

  const openEditor = (patch: { ubah?: string; baru?: boolean }) => setOverlay(patch)
  const closeEditor = useCallback(() => setOverlay({ ubah: '', baru: false }, { replace: true }), [setOverlay])

  const importDone = () => void Promise.all([list.refetch(), refetchCategories()])
  const totalPages = Math.max(1, Math.ceil(list.total / state.per))

  return (
    <>
      <PageHeader
        title="Produk"
        count={list.loaded ? `${list.total} produk` : undefined}
        subtitle="Katalog, harga dasar dan ketersediaan per outlet. Stok diatur di Inventori."
        actions={
          <>
            {tabs}
            <ImportExportBar
              onExport={list.exportAll}
              exportDisabled={list.loaded && list.total === 0}
              filterSummary={list.filterSummary}
              importKind="products"
              onImported={importDone}
              onTemplate={downloadProductTemplate}
            />
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => openEditor({ baru: true, ubah: '' })}>
              Tambah
            </Button>
          </>
        }
      />

      <ProductsFilters state={state} categories={categories} activeCount={list.activeCount} onChange={list.setFilter} onReset={list.reset} />

      <ProductsTable
        rows={list.rows}
        catName={catName}
        loading={list.loading}
        error={list.error ? 'Daftar produk gagal dimuat.' : null}
        onRetry={() => void list.refetch()}
        selectedId={editingId}
        filtered={list.activeCount > 0}
        onEdit={(p) => openEditor({ ubah: p.id, baru: false })}
        onDelete={del.ask}
        footer={
          <Pagination
            page={state.hal}
            totalPages={totalPages}
            total={list.total}
            onChange={list.setPage}
            pageSize={state.per}
            onPageSizeChange={list.setPageSize}
            pageSizes={[...PRODUCT_PAGE_SIZES]}
          />
        }
      />

      {overlayOpen && (
        <ProductEditorHost
          key={editingId ?? 'baru'}
          productId={editingId}
          categories={categories}
          closeEditor={closeEditor}
          refetchList={list.refetch}
        />
      )}

      <DeleteConfirmDialog
        open={del.target !== null}
        subject={del.target ? `produk "${del.target.name}"` : 'produk'}
        error={del.error}
        busy={del.busy}
        onConfirm={() => void del.confirm()}
        onCancel={del.cancel}
      />
    </>
  )
}
