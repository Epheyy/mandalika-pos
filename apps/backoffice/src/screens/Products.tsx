import type { ReactNode } from 'react'
import type { Bundle, Category } from '@mandalika/api'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { BundlesPanel } from './products/BundlesPanel'
import { CategoriesView } from './products/CategoriesView'
import { ProductsListView } from './products/ProductsListView'

type ProductsTab = 'products' | 'categories' | 'bundles'

// Bundles are polled only while their tab is open.
function BundlesView({ tabs }: { tabs: ReactNode }) {
  const q = usePolledQuery<Bundle[]>(() => api.listBundles(), [])
  const bundles = q.data ?? []
  return (
    <>
      <PageHeader title="Produk" count={q.data ? `${bundles.length} bundle` : undefined} subtitle="Paket produk yang dijual dengan harga tetap." actions={tabs} />
      <BundlesPanel bundles={bundles} loading={q.loading && !q.data} error={q.error ? 'Bundle gagal dimuat.' : null} onRetry={() => void q.refetch()} />
    </>
  )
}

export default function Products() {
  // The tab lives in the path (#/produk/kategori); a bare #/produk is Produk.
  const { strip, tab: routedTab, setTab } = useScreenTabs<ProductsTab>('products', null)
  const tab = routedTab ?? 'products'
  // Categories feed the list's filter, the editor's picker and the Kategori tab.
  const cq = usePolledQuery<Category[]>(() => api.listCategories(), [])
  const categories = cq.data ?? []
  const tabs = <Tabs value={tab} onChange={setTab} tabs={strip} />

  return (
    <div className="p-6 space-y-5">
      {tab === 'products' && <ProductsListView categories={categories} refetchCategories={cq.refetch} tabs={tabs} />}
      {tab === 'categories' && <CategoriesView categories={categories} loading={cq.loading} error={cq.error} refetch={cq.refetch} tabs={tabs} />}
      {tab === 'bundles' && <BundlesView tabs={tabs} />}
    </div>
  )
}
