import { useMemo, useState, type FormEvent } from 'react'
import {
  LayoutDashboard,
  Package,
  Users as UsersIcon,
  Store,
  LogOut,
  Menu,
  X,
  UserCog,
  Tag,
  BarChart3,
  ClipboardList,
  Settings,
  Receipt,
} from 'lucide-react'
import { useAuth } from './auth'
import { OutletSwitcher } from './outlet'
import { BRAND } from './lib/brand'

import Dashboard from './screens/Dashboard'
import Products from './screens/Products'
import Customers from './screens/Customers'
import Promotions from './screens/Promotions'
import Orders from './screens/Orders'
import Reports from './screens/Reports'
import StockCount from './screens/StockCount'
import Outlets from './screens/Outlets'
import Users from './screens/Users'
import SettingsScreen from './screens/SettingsScreen'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'view_dashboard', C: Dashboard },
  { id: 'products', label: 'Produk', icon: Package, perm: 'manage_products', C: Products },
  { id: 'customers', label: 'Pelanggan', icon: UsersIcon, perm: 'manage_customers', C: Customers },
  { id: 'promotions', label: 'Promosi', icon: Tag, perm: 'manage_promotions', C: Promotions },
  { id: 'orders', label: 'Transaksi', icon: Receipt, perm: 'view_transactions', C: Orders },
  { id: 'reports', label: 'Laporan', icon: BarChart3, perm: 'view_reports', C: Reports },
  { id: 'stock', label: 'Stock Count', icon: ClipboardList, perm: 'manage_stock_count', C: StockCount },
  { id: 'outlets', label: 'Outlet', icon: Store, perm: 'manage_outlets', C: Outlets },
  { id: 'users', label: 'Pengguna', icon: UserCog, perm: 'manage_users', C: Users },
  { id: 'settings', label: 'Pengaturan', icon: Settings, perm: 'manage_settings', C: SettingsScreen },
] as const

function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('admin@mandalika.local')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(email, password)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={onSubmit}
        className="bg-white rounded-3xl shadow-xl border border-gray-100 p-8 w-full max-w-sm space-y-4"
      >
        <div className="text-center">
          <img src={BRAND.logoUrl} alt="" className="h-10 mx-auto mb-3 object-contain" />
          <h1 className="text-xl font-black text-gray-900">Mandalika Back Office</h1>
          <p className="text-xs text-gray-400">Masuk dengan akun admin / manajer</p>
        </div>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="username"
          className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="Kata sandi"
          autoComplete="current-password"
          className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          disabled={busy}
          type="submit"
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl transition-all"
        >
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        {err && <p className="text-sm text-center text-red-600">{err}</p>}
      </form>
    </div>
  )
}

export default function App() {
  const { user, ready, logout } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const visible = useMemo(() => {
    if (!user) return []
    const isAdmin = user.role === 'admin'
    const perms = user.permissions || []
    return NAV.filter((n) => isAdmin || perms.includes(n.perm))
  }, [user])

  const [activeId, setActiveId] = useState<string>('dashboard')

  if (!ready)
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Memuat…
      </div>
    )
  if (!user) return <LoginScreen />

  const active = visible.find((n) => n.id === activeId) ?? visible[0]
  const Screen = active?.C

  return (
    <div className="h-screen flex bg-gray-50 overflow-hidden">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-white border-r border-gray-200 flex flex-col transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="px-5 py-5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={BRAND.logoUrl} alt="" className="w-9 h-7 object-contain" />
            <div>
              <p className="text-sm font-black text-gray-900">{BRAND.name}</p>
              <p
                className="text-xs font-bold"
                style={{ color: BRAND.colors.primaryHex }}
              >
                Back Office
              </p>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 hover:bg-gray-100 rounded-lg"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="text-xs text-gray-400 px-3 py-2">
              Tidak ada menu yang dapat diakses.
            </p>
          ) : (
            visible.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setActiveId(id)
                  setSidebarOpen(false)
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  active?.id === id
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{label}</span>
              </button>
            ))
          )}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xs font-black text-indigo-600">
                  {user.displayName.charAt(0)}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">
                {user.displayName}
              </p>
              <p className="text-xs text-gray-400 capitalize">{user.role}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all"
          >
            <LogOut className="w-4 h-4" /> Keluar
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 hover:bg-gray-100 rounded-xl"
          >
            <Menu className="w-5 h-5 text-gray-500" />
          </button>
          <h1 className="text-lg font-black text-gray-900">
            {active?.label ?? ''}
          </h1>
          <div className="flex-1" />
          <OutletSwitcher />
        </header>
        <main className="flex-1 overflow-y-auto">
          {Screen ? (
            <Screen />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-300 p-12">
              <UserCog className="w-12 h-12" />
              <p className="font-bold text-gray-400">Akses tidak diizinkan</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
