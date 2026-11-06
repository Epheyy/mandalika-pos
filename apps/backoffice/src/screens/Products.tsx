import { useEffect, useRef, type ReactNode } from 'react'
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
  // Each tab renders its own header, so the strip remounts on every switch and keyboard focus would fall to <body>.
  // When the switch came from the strip itself, put focus back on the selected tab once the new view has mounted.
  const refocusTab = useRef(false)
  const changeTab = (next: ProductsTab) => {
    refocusTab.current = next !== tab && document.activeElement instanceof HTMLElement && document.activeElement.getAttribute('role') === 'tab'
    setTab(next)
  }
  useEffect(() => {
    if (!refocusTab.current) return
    refocusTab.current = false
    document.querySelector<HTMLElement>(`[role="tab"][data-tab-key="${tab}"]`)?.focus()
  }, [tab])
  const tabs = <Tabs value={tab} onChange={changeTab} tabs={strip} label="Bagian Produk" />

  return (
    <div className="p-6 space-y-5">
      {tab === 'products' && <ProductsListView categories={categories} refetchCategories={cq.refetch} tabs={tabs} />}
      {tab === 'categories' && <CategoriesView categories={categories} loading={cq.loading} error={cq.error} refetch={cq.refetch} tabs={tabs} />}
      {tab === 'bundles' && <BundlesView tabs={tabs} />}
    </div>
  )
}
