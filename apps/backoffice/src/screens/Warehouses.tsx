import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Tabs } from '../ui'
import { Transfers } from './transfers/Transfers'
import Ingredients from './ingredients/Ingredients'
import StokProduk from './inventory/StokProduk'
import StockCount from './StockCount'

type InventoriTab = 'stok' | 'transfer' | 'bahan' | 'opname'

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

  const tabs = useMemo(() => {
    const list: Array<{ id: InventoriTab; label: string }> = []
    if (canInventory) list.push({ id: 'stok', label: 'Stok Produk' })
    if (canInventory) list.push({ id: 'transfer', label: 'Transfer' })
    if (canInventory && recipesEnabled) list.push({ id: 'bahan', label: 'Bahan' })
    if (canOpname) list.push({ id: 'opname', label: 'Opname' })
    return list
  }, [canInventory, canOpname, recipesEnabled])

  const defaultTab: InventoriTab = tabs[0]?.id ?? 'stok'
  const [tab, setTab] = useState<InventoriTab>(defaultTab)

  // When the visible tab set changes (e.g. recipesEnabled loads), make sure the
  // active tab is still in the list; if not, fall back to the first available.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? 'stok')

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
        <Tabs value={activeTab} onChange={(v) => setTab(v as InventoriTab)} tabs={tabs} />
      </div>
      {activeTab === 'stok' && canInventory && <StokProduk />}
      {activeTab === 'transfer' && canInventory && (
        <div className="px-6 pb-6 pt-2">
          <Transfers />
        </div>
      )}
      {activeTab === 'bahan' && canInventory && recipesEnabled && (
        <div className="px-6 pb-6 pt-2">
          <Ingredients />
        </div>
      )}
      {activeTab === 'opname' && canOpname && <StockCount />}
    </div>
  )
}
