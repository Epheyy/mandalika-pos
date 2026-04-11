import { useState, useEffect } from 'react'
import type { AppUser } from '../../types'
import { UserPermission } from '../../types'
import { BRAND } from '../../config/brand'
import { LayoutDashboard, Package, Users, Store, LogOut, ChevronRight, Menu, X, UserCog, Tag, BarChart3, ClipboardList, Settings } from 'lucide-react'

import Dashboard from './screens/Dashboard'
import Products from './screens/Products'
import Customers from './screens/Customers'
import Outlets from './screens/Outlets'
import UsersScreen from './screens/Users'
import Promotions from './screens/Promotions'
import Reports from './screens/Reports'
import StockCount from './screens/StockCount'
import SettingsScreen from './screens/SettingsScreen'

interface Props { appUser: AppUser; onLogout: () => void }

const ALL_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: UserPermission.VIEW_DASHBOARD },
  { id: 'products', label: 'Produk', icon: Package, permission: UserPermission.MANAGE_PRODUCTS },
  { id: 'customers', label: 'Pelanggan', icon: Users, permission: UserPermission.MANAGE_CUSTOMERS },
  { id: 'promotions', label: 'Promosi', icon: Tag, permission: UserPermission.MANAGE_PROMOTIONS },
  { id: 'reports', label: 'Laporan', icon: BarChart3, permission: UserPermission.VIEW_REPORTS },
  { id: 'stock_count', label: 'Stock Count', icon: ClipboardList, permission: UserPermission.MANAGE_STOCK_COUNT },
  { id: 'outlets', label: 'Outlet', icon: Store, permission: UserPermission.MANAGE_OUTLETS },
  { id: 'users', label: 'Pengguna', icon: UserCog, permission: UserPermission.MANAGE_USERS },
  { id: 'settings', label: 'Pengaturan', icon: Settings, permission: UserPermission.MANAGE_SETTINGS },
] as const

type TabId = typeof ALL_NAV_ITEMS[number]['id']

export default function BackOfficeScreen({ appUser, onLogout }: Props) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  const hasAccess = (permission: UserPermission) => {
    if (appUser.role === 'admin') return true
    return (appUser.permissions || []).includes(permission)
  }

  const visibleNavItems = ALL_NAV_ITEMS.filter(item => hasAccess(item.permission))
  const [activeTab, setActiveTab] = useState<TabId>(visibleNavItems.length > 0 ? visibleNavItems[0].id : 'dashboard')

  useEffect(() => {
    if (!visibleNavItems.find(n => n.id === activeTab) && visibleNavItems.length > 0) {
      setActiveTab(visibleNavItems[0].id)
    }
  }, [activeTab])

  const renderScreen = () => {
    if (!visibleNavItems.find(n => n.id === activeTab)) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-300 p-12">
          <UserCog className="w-12 h-12" />
          <p className="font-bold text-gray-400">Akses tidak diizinkan</p>
          <p className="text-sm text-center text-gray-400">Hubungi admin untuk akses halaman ini.</p>
        </div>
      )
    }
    switch (activeTab) {
      case 'dashboard': return <Dashboard appUser={appUser} />
      case 'products': return <Products appUser={appUser} />
      case 'customers': return <Customers appUser={appUser} />
      case 'promotions': return <Promotions appUser={appUser} />
      case 'reports': return <Reports appUser={appUser} />
      case 'stock_count': return <StockCount appUser={appUser} />
      case 'outlets': return <Outlets appUser={appUser} />
      case 'users': return <UsersScreen appUser={appUser} />
      case 'settings': return <SettingsScreen appUser={appUser} />
      default: return <Dashboard appUser={appUser} />
    }
  }

  const activeLabel = ALL_NAV_ITEMS.find(n => n.id === activeTab)?.label || ''

  return (
    <div className="h-screen flex bg-gray-50 overflow-hidden">
      <>
        {isSidebarOpen && <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setIsSidebarOpen(false)} />}
        <aside className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-white border-r border-gray-200 flex flex-col transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
          <div className="px-5 py-5 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-8 flex items-center justify-center flex-shrink-0">
                <img src={BRAND.logoUrl} alt="Mandalika" className="w-full h-full object-contain" />
              </div>
            <div>
              <p className="text-sm font-black text-gray-900">{BRAND.name}</p>
              <p className="text-xs font-bold" style={{ color: BRAND.colors.primaryHex }}>Back Office</p>
              </div>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-1 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4 text-gray-400" /></button>
          </div>
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {visibleNavItems.length === 0 ? <p className="text-xs text-gray-400 px-3 py-2">Tidak ada menu yang dapat diakses.</p>
              : visibleNavItems.map(({ id, label, icon: Icon }) => (
                <button key={id} onClick={() => { setActiveTab(id); setIsSidebarOpen(false) }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}>
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span className="flex-1 text-left">{label}</span>
                  {activeTab === id && <ChevronRight className="w-4 h-4 opacity-70" />}
                </button>
              ))}
          </nav>
          <div className="p-3 border-t border-gray-100 space-y-2">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                {appUser.photoURL ? <img src={appUser.photoURL} alt="" className="w-full h-full object-cover" /> : <span className="text-xs font-black text-indigo-600">{appUser.displayName.charAt(0)}</span>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{appUser.displayName}</p>
                <p className="text-xs text-gray-400 capitalize">{appUser.role}</p>
              </div>
            </div>
            <button onClick={onLogout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all">
              <LogOut className="w-4 h-4" /> Keluar
            </button>
          </div>
        </aside>
      </>
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
          <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 hover:bg-gray-100 rounded-xl"><Menu className="w-5 h-5 text-gray-500" /></button>
          <h1 className="text-lg font-black text-gray-900">{activeLabel}</h1>
          <div className="flex-1" />
          <a href="/"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-xl text-xs transition-all">
            ← Kembali ke Kasir
          </a>
        </header>
        <main className="flex-1 overflow-y-auto">{renderScreen()}</main>
      </div>
    </div>
  )
}