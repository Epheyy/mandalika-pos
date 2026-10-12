import { useMemo, useState, type FormEvent } from 'react'
import {
  LayoutDashboard,
  Package,
  Users as UsersIcon,
  LogOut,
  Menu,
  X,
  UserCog,
  Tag,
  BarChart3,
  Settings,
  AlertTriangle,
  Warehouse,
  ClipboardCheck,
} from 'lucide-react'
import { useAuth } from './auth'
import { OutletSwitcher } from './outlet'
import { BRAND } from './lib/brand'
import { Button } from './ui/Button'
import { Input } from './ui/Field'
import { Card } from './ui/Card'

import Dashboard from './screens/Dashboard'
import Products from './screens/Products'
import Customers from './screens/Customers'
import Promotions from './screens/Promotions'
import Reports from './screens/Reports'
import Warehouses from './screens/Warehouses'
import Users from './screens/Users'
import SettingsScreen from './screens/SettingsScreen'
import ErrorLogs from './screens/ErrorLogs'
import SyncReview from './screens/syncReview/SyncReview'
import { useSyncReviewCount } from './screens/syncReview/useSyncReviewCount'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'view_dashboard', C: Dashboard },
  { id: 'products', label: 'Produk', icon: Package, perm: 'manage_products', C: Products },
  { id: 'customers', label: 'Pelanggan', icon: UsersIcon, perm: 'manage_customers', C: Customers },
  { id: 'promotions', label: 'Promosi', icon: Tag, perm: 'manage_promotions', C: Promotions },
  { id: 'reports', label: 'Laporan', icon: BarChart3, perm: 'view_reports', C: Reports },
  { id: 'warehouses', label: 'Inventori', icon: Warehouse, perm: 'manage_inventory', C: Warehouses },
  { id: 'users', label: 'Pengguna', icon: UserCog, perm: 'manage_users', C: Users },
  { id: 'syncReview', label: 'Tinjauan Sinkron', icon: ClipboardCheck, perm: 'resolve_sync_review', C: SyncReview },
  { id: 'settings', label: 'Pengaturan', icon: Settings, perm: 'manage_settings', C: SettingsScreen },
  // Admin-only: 'view_error_logs' isn't granted to any role, so it shows only
  // via the isAdmin bypass (and the GET endpoint is admin-gated server-side).
  { id: 'errors', label: 'Log Error', icon: AlertTriangle, perm: 'view_error_logs', C: ErrorLogs },
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="shadow-xl p-8 w-full max-w-sm">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="text-center">
            <img src={BRAND.logoUrl} alt="" className="h-10 mx-auto mb-3 object-contain" />
            <h1 className="text-xl font-black text-gray-900">Mandalika Back Office</h1>
            <p className="text-xs text-gray-400">Masuk dengan akun admin / manajer</p>
          </div>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            aria-label="Email"
            autoComplete="username"
          />
          <Input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Kata sandi"
            aria-label="Kata sandi"
            autoComplete="current-password"
          />
          <Button type="submit" loading={busy} className="w-full py-3 rounded-2xl">
            {busy ? 'Memproses…' : 'Masuk'}
          </Button>
          {err && <p className="text-sm text-center text-red-600">{err}</p>}
        </form>
      </Card>
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
    return NAV.filter((n) => {
      if (isAdmin) return true
      if (n.id === 'warehouses') return perms.includes('manage_inventory') || perms.includes('manage_stock_count')
      if (n.id === 'reports') return perms.includes('view_reports') || perms.includes('view_transactions')
      return perms.includes(n.perm)
    })
  }, [user])

  const reviewCount = useSyncReviewCount(visible.some((n) => n.id === 'syncReview'))

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
        <button
          type="button"
          aria-label="Tutup menu"
          tabIndex={-1}
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
          <button type="button"
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
              <button type="button"
                key={id}
                onClick={() => {
                  setActiveId(id)
                  setSidebarOpen(false)
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  active?.id === id
                    ? 'bg-gold-600 text-white shadow-lg shadow-gold-600/10'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{label}</span>
                {id === 'syncReview' && reviewCount > 0 && (
                  <span className="min-w-5 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-black text-center"
                    aria-label={`${reviewCount} item terbuka`}>{reviewCount}</span>
                )}
              </button>
            ))
          )}
        </nav>
        <div className="p-3 border-t border-gray-100">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-gold-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xs font-black text-gold-700">
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
          <button type="button"
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all"
          >
            <LogOut className="w-4 h-4" /> Keluar
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
          <button type="button"
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 hover:bg-gray-100 rounded-xl"
          >
            <Menu className="w-5 h-5 text-gray-500" />
          </button>
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
