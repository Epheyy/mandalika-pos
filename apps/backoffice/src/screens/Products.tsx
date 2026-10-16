import { Plus, Download } from 'lucide-react'
import { api } from '../api'
import { RecipeSlideOver } from './recipes/RecipeSlideOver'
import { ImportExportBar } from '../components/ImportExportBar'
import { exportToCSV } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { ProductsTable } from './products/ProductsTable'
import { CategoriesTable } from './products/CategoriesTable'
import { BundlesPanel } from './products/BundlesPanel'
import { ProductFormModal } from './products/ProductFormModal'
import { CategoryFormModal } from './products/CategoryFormModal'
import { DeleteConfirmModal } from './products/DeleteConfirmModal'
import { useProductsData } from './products/useProductsData'
import { EMPTY, EMPTY_VARIANT } from './products/types'

export default function Products() {
  const d = useProductsData()

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Produk"
        subtitle={`${d.products.length} produk · ${d.categories.length} kategori · ${d.bundles.length} bundle`}
        actions={
          <>
            <Tabs
              value={d.tab}
              onChange={d.setTab}
              tabs={[
                { id: 'products', label: 'Produk' },
                { id: 'categories', label: 'Kategori' },
                { id: 'bundles', label: 'Bundle' },
              ]}
            />
            {d.tab === 'products' && (
              <>
                <ImportExportBar
                  onExport={d.exportProducts}
                  exportDisabled={d.products.length === 0}
                  importKind="products"
                  onImported={d.refetchAfterImport}
                  onTemplate={d.downloadProductTemplate}
                />
                <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { d.setEditing(null); d.setForm({ ...EMPTY, variants: [{ ...EMPTY_VARIANT }] }); d.setErr(null); d.setOcfgOutlets([]); d.setOcfgMap({}); d.setOpen(true) }}>
                  Tambah
                </Button>
              </>
            )}
            {d.tab === 'categories' && (
              <>
                <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => exportToCSV(d.categories.map((c) => ({ Nama: c.name, Deskripsi: c.description || '', Urutan: c.sortOrder || 0 })), 'kategori_mandalika')}>
                  Export
                </Button>
                <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => { d.setEditingCat(null); d.setCatForm({ name: '', description: '' }); d.setCatOpen(true) }}>
                  Tambah
                </Button>
              </>
            )}
          </>
        }
      />

      {d.tab === 'products' && (
        <ProductsTable
          loading={d.pqLoading}
          filtered={d.filtered}
          categories={d.categories}
          search={d.search}
          setSearch={d.setSearch}
          fCat={d.fCat}
          setFCat={d.setFCat}
          catName={d.catName}
          onEdit={d.openEdit}
          onDelete={d.setDelId}
        />
      )}

      {d.tab === 'categories' && (
        <CategoriesTable
          categories={d.categories}
          products={d.products}
          onEdit={(c) => { d.setEditingCat(c); d.setCatForm({ name: c.name, description: c.description || '' }); d.setCatOpen(true) }}
          onDelete={d.setDelCatId}
        />
      )}

      {d.tab === 'bundles' && <BundlesPanel bundles={d.bundles} />}

      <ProductFormModal
        open={d.open}
        onClose={() => d.setOpen(false)}
        editing={!!d.editing}
        busy={d.busy}
        err={d.err}
        onSave={d.save}
        form={d.form}
        setForm={d.setForm}
        categories={d.categories}
        uploading={d.uploading}
        onImage={d.onImage}
        removeImage={d.removeImage}
        makeMainImage={d.makeMainImage}
        recipesEnabled={d.recipesEnabled}
        recipeVariantIds={d.recipeVariantIds}
        onUpdVariant={d.updVariant}
        onAddVariant={d.addVariant}
        onRemoveVariant={d.removeVariant}
        setRecipeFor={d.setRecipeFor}
        ocfgLoading={d.ocfgLoading}
        ocfgOutlets={d.ocfgOutlets}
        ocGet={d.ocGet}
        ocSet={d.ocSet}
        setOutletAllAvailable={d.setOutletAllAvailable}
        basePriceOf={d.basePriceOf}
        ocCollapsed={d.ocCollapsed}
        setOcCollapsed={d.setOcCollapsed}
      />

      <CategoryFormModal
        open={d.catOpen}
        editingCat={d.editingCat}
        catForm={d.catForm}
        setCatForm={d.setCatForm}
        busy={d.busy}
        onSave={d.saveCat}
        onClose={() => d.setCatOpen(false)}
      />

      <DeleteConfirmModal
        open={!!(d.delId || d.delCatId)}
        onClose={() => { d.setDelId(null); d.setDelCatId(null) }}
        onConfirm={async () => { if (d.delId) await d.del(d.delId); if (d.delCatId) { await api.deleteCategory(d.delCatId); d.setDelCatId(null); await d.refetchCats() } }}
      />

      {d.recipeFor && (
        <RecipeSlideOver
          productId={d.editing?.id ?? ''}
          variantId={d.recipeFor.variantId}
          variantLabel={d.recipeFor.label}
          onClose={() => {
            d.setRecipeFor(null)
            if (d.editing?.id && d.recipesEnabled) {
              api.getRecipeVariantIds(d.editing.id)
                .then((ids) => d.setRecipeVariantIds(new Set(ids)))
                .catch(() => {})
            }
          }}
        />
      )}
    </div>
  )
}
