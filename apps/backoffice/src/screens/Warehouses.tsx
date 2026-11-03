import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Tabs } from '../ui/Tabs'
import { useScreenTabs } from '../lib/router/useScreenTabs'
import { Transfers } from './transfers/Transfers'
import Ingredients from './ingredients/Ingredients'
import StokProduk from './inventory/StokProduk'
import { GoodsReceiptsList } from './inventory/GoodsReceiptsList'
import OpnameSection from './inventory/OpnameSection'

type InventoriTab = 'stok' | 'transfer' | 'barangMasuk' | 'bahan' | 'opname'

export default function Inventori() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const perms: string[] = user?.permissions ?? []

  const canInventory = isAdmin || perms.includes('manage_inventory')
  const canOpname = isAdmin || perms.includes('manage_stock_count')

  const [recipesEnabled, setRecipesEnabled] = useState(false)

  useEffect(() => {
    api
      .getAppSettings()
      .then((settings) => {
        setRecipesEnabled(settings.recipesEnabled === true)
      })
      .catch(() => {
        // silently ignore — flag stays false
      })
  }, [])

  // The tab lives in the path (#/inventori/transfer). Bahan waits for recipesEnabled: until it loads, a URL naming
  // Bahan shows the first tab, then lands on Bahan (the tab set is re-resolved, nothing is rewritten).
  const { tabs: routeTabs, tab: activeTab, setTab } = useScreenTabs<InventoriTab>('warehouses', user, recipesEnabled ? [] : ['bahan'])
  const tabs = routeTabs.map((t) => ({ id: t.key, label: t.label }))

  if (tabs.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-400">
        Tidak ada tab yang dapat diakses.
      </div>
    )
  }

  return (
    <div>
      <div className="px-6 pt-6">
        <Tabs value={activeTab ?? 'stok'} onChange={setTab} tabs={tabs} />
      </div>
      {activeTab === 'stok' && canInventory && <StokProduk />}
      {activeTab === 'transfer' && canInventory && (
        <div className="px-6 pb-6 pt-2">
          <Transfers />
        </div>
      )}
      {activeTab === 'barangMasuk' && canInventory && (
        <div className="px-6 pb-6 pt-2">
          <GoodsReceiptsList />
        </div>
      )}
      {activeTab === 'bahan' && canInventory && recipesEnabled && (
        <div className="px-6 pb-6 pt-2">
          <Ingredients />
        </div>
      )}
      {activeTab === 'opname' && canOpname && <OpnameSection recipesEnabled={recipesEnabled} />}
    </div>
  )
}
