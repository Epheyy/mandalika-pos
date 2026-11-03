/*
 * The single route table. The sidebar, the breadcrumb, the access check and the screen loader all read it.
 * Nav ids are the existing ones (lib/navAccess.ts and its test key on them). Paths are Indonesian slugs (D-69).
 */
import type { ComponentType } from 'react'
import {
  AlertTriangle,
  BarChart3,
  Cable,
  ClipboardCheck,
  ClipboardList,
  LayoutDashboard,
  Package,
  Settings,
  Tag,
  UserCog,
  Users as UsersIcon,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'
import { canSeeNav, type NavUser } from '../navAccess'
import { buildHash, type Location } from './hash'

export type NavId =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'promotions'
  | 'reports'
  | 'warehouses'
  | 'approvals'
  | 'requisitions'
  | 'users'
  | 'syncReview'
  | 'settings'
  | 'erpOutbox'
  | 'errors'

export type SectionId = 'penjualan' | 'pelanggan' | 'produk-stok' | 'operasional' | 'sistem'

/** A top-level tab of a screen: it lives in the path as "#/<screen>/<slug>". */
export interface RouteTab<K extends string = string> {
  /** The id the screen and the tests know the tab by (data-tab-key). */
  key: K
  /** The path segment. */
  slug: string
  /** Static name for the breadcrumb; the tab strip may append a count. */
  label: string
  /** Permission the tab needs (admin always passes). Left out = anyone who can open the screen. */
  perm?: string
}

export interface RouteDef {
  id: NavId
  /** First path segment, e.g. "inventori" for "#/inventori/...". */
  path: string
  /** Sidebar and breadcrumb label. */
  label: string
  section: SectionId
  icon: LucideIcon
  /** Input to canSeeNav. */
  perm: string
  /** One lazy chunk per screen, so recharts and jspdf stay out of the first bundle. */
  load: () => Promise<{ default: ComponentType }>
  /**
   * Top-level tabs in order. A bare "#/<screen>" shows the first one the user may open. A tab that is also gated
   * on a setting that loads later (Bahan: recipesEnabled) is filtered by the screen itself.
   */
  tabs?: readonly RouteTab[]
}

export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'penjualan', label: 'Penjualan' },
  { id: 'pelanggan', label: 'Pelanggan' },
  { id: 'produk-stok', label: 'Produk & Stok' },
  { id: 'operasional', label: 'Operasional' },
  { id: 'sistem', label: 'Sistem' },
]

const tab = (key: string, slug: string, label: string, perm?: string): RouteTab => ({ key, slug, label, ...(perm ? { perm } : {}) })

// Slugs are the final Indonesian names (D-69). The first tab is what a bare "#/<screen>" shows.
const REPORT_TABS: readonly RouteTab[] = [
  tab('orders', 'transaksi', 'Transaksi', 'view_transactions'),
  tab('export', 'ekspor', 'Ekspor', 'view_reports'),
  tab('shifts', 'shift', 'Shift', 'view_reports'),
  tab('grants', 'hadiah-promo', 'Hadiah Promo', 'view_reports'),
  tab('codeReport', 'kode-diskon', 'Kode Diskon', 'view_reports'),
  tab('refund', 'refund', 'Refund', 'view_reports'),
  tab('oversell', 'stok-minus', 'Stok Minus', 'view_reports'),
]
const INVENTORY_TABS: readonly RouteTab[] = [
  tab('stok', 'stok', 'Stok Produk', 'manage_inventory'),
  tab('transfer', 'transfer', 'Transfer', 'manage_inventory'),
  tab('bahan', 'bahan', 'Bahan', 'manage_inventory'),
  tab('opname', 'opname', 'Opname', 'manage_stock_count'),
]
const CUSTOMER_TABS: readonly RouteTab[] = [
  tab('daftar', 'daftar', 'Daftar'),
  tab('pengingat', 'pengingat', 'Pengingat'),
  tab('duplikat', 'duplikat', 'Duplikat'),
  tab('loyalitas', 'loyalitas', 'Loyalitas'),
]
const PROMOTION_TABS: readonly RouteTab[] = [tab('promotions', 'daftar', 'Promosi'), tab('codes', 'kode', 'Kode Diskon')]
const PRODUCT_TABS: readonly RouteTab[] = [
  tab('products', 'daftar', 'Produk'),
  tab('categories', 'kategori', 'Kategori'),
  tab('bundles', 'bundle', 'Bundle'),
]
const USER_TABS: readonly RouteTab[] = [tab('users', 'daftar', 'Pengguna'), tab('roles', 'role', 'Manajemen Role')]
const SYNC_REVIEW_TABS: readonly RouteTab[] = [tab('open', 'terbuka', 'Terbuka'), tab('resolved', 'selesai', 'Selesai')]
const SETTINGS_TABS: readonly RouteTab[] = [
  tab('locations', 'outlet-gudang', 'Outlet & Gudang'),
  tab('transaksi', 'transaksi', 'Transaksi'),
  tab('operasional', 'operasional', 'Operasional'),
  tab('recipe', 'resep-bahan', 'Resep & Bahan'),
]

// Order here is the order in the sidebar inside each section (D-16).
export const ROUTES: readonly RouteDef[] = [
  { id: 'dashboard', path: 'ringkasan', label: 'Ringkasan', section: 'penjualan', icon: LayoutDashboard, perm: 'view_dashboard', load: () => import('../../screens/Dashboard') },
  { id: 'reports', path: 'laporan', label: 'Laporan', section: 'penjualan', icon: BarChart3, perm: 'view_reports', load: () => import('../../screens/Reports'), tabs: REPORT_TABS },
  { id: 'customers', path: 'pelanggan', label: 'Pelanggan', section: 'pelanggan', icon: UsersIcon, perm: 'manage_customers', load: () => import('../../screens/Customers'), tabs: CUSTOMER_TABS },
  { id: 'promotions', path: 'promosi', label: 'Promosi', section: 'pelanggan', icon: Tag, perm: 'manage_promotions', load: () => import('../../screens/Promotions'), tabs: PROMOTION_TABS },
  { id: 'products', path: 'produk', label: 'Produk', section: 'produk-stok', icon: Package, perm: 'manage_products', load: () => import('../../screens/Products'), tabs: PRODUCT_TABS },
  { id: 'warehouses', path: 'inventori', label: 'Inventori', section: 'produk-stok', icon: Warehouse, perm: 'manage_inventory', load: () => import('../../screens/Warehouses'), tabs: INVENTORY_TABS },
  { id: 'approvals', path: 'persetujuan-stok', label: 'Persetujuan Stok', section: 'produk-stok', icon: ClipboardCheck, perm: 'manage_inventory', load: () => import('../../screens/approvals/ApprovalQueue') },
  { id: 'requisitions', path: 'permintaan-barang', label: 'Permintaan Barang', section: 'produk-stok', icon: ClipboardList, perm: 'request_stock', load: () => import('../../screens/requisitions/RequisitionList') },
  { id: 'users', path: 'pengguna', label: 'Pengguna', section: 'operasional', icon: UserCog, perm: 'manage_users', load: () => import('../../screens/Users'), tabs: USER_TABS },
  { id: 'syncReview', path: 'tinjauan-sinkron', label: 'Tinjauan Sinkron', section: 'operasional', icon: ClipboardCheck, perm: 'resolve_sync_review', load: () => import('../../screens/syncReview/SyncReview'), tabs: SYNC_REVIEW_TABS },
  { id: 'settings', path: 'pengaturan', label: 'Pengaturan', section: 'operasional', icon: Settings, perm: 'manage_settings', load: () => import('../../screens/SettingsScreen'), tabs: SETTINGS_TABS },
  // Admin-only: no role is granted 'manage_erp_integration'; the endpoints are admin-gated server-side.
  { id: 'erpOutbox', path: 'integrasi-erp', label: 'Integrasi ERP', section: 'sistem', icon: Cable, perm: 'manage_erp_integration', load: () => import('../../screens/integration/ErpOutboxScreen') },
  // Admin-only: 'view_error_logs' isn't granted to any role, so it shows only via the isAdmin bypass.
  { id: 'errors', path: 'log-kesalahan', label: 'Log Kesalahan', section: 'sistem', icon: AlertTriangle, perm: 'view_error_logs', load: () => import('../../screens/ErrorLogs') },
]

/** The top-level tabs of a screen, typed with the screen's own tab ids. */
export const tabsOf = <K extends string>(id: NavId): readonly RouteTab<K>[] =>
  (routeById(id)?.tabs ?? []) as readonly RouteTab<K>[]

/** Whether the user may open a tab by its own permission (admin always). Settings that load later are not checked here. */
export function canSeeTab(tab: RouteTab, user: NavUser | null): boolean {
  if (!tab.perm) return true
  if (!user) return false
  if (user.role === 'admin') return true
  return (user.permissions ?? []).includes(tab.perm)
}

/** The tab a path names under `route`, or the first one the user may open when the path names none. */
export function tabForPath(route: RouteDef, path: readonly string[], user: NavUser | null): RouteTab | undefined {
  const allowed = (route.tabs ?? []).filter((t) => canSeeTab(t, user))
  return allowed.find((t) => t.slug === path[1]) ?? allowed[0]
}

export const routeById = (id: string): RouteDef | undefined => ROUTES.find((r) => r.id === id)

/** The hash a sidebar link or redirect points to. */
export const hashFor = (route: RouteDef): string => buildHash([route.path])

export const sectionLabel = (id: SectionId): string => SECTIONS.find((s) => s.id === id)?.label ?? ''

export function visibleRoutes(user: NavUser | null): RouteDef[] {
  return ROUTES.filter((r) => canSeeNav(r.id, r.perm, user))
}

export interface RouteGroup {
  section: { id: SectionId; label: string }
  routes: RouteDef[]
}

/** Sidebar sections in order; a section with nothing visible is left out. */
export function groupBySection(routes: readonly RouteDef[]): RouteGroup[] {
  return SECTIONS.map((section) => ({ section, routes: routes.filter((r) => r.section === section.id) })).filter(
    (g) => g.routes.length > 0,
  )
}

export type Resolution =
  | { kind: 'screen'; route: RouteDef }
  /** Unknown or empty path: go to the first menu item the user can see (replace, not push). */
  | { kind: 'redirect'; to: string }
  /** A real screen the user may not open: "Akses tidak diizinkan". */
  | { kind: 'forbidden'; route: RouteDef }
  /** Nothing visible at all. */
  | { kind: 'none' }

export function resolveLocation(loc: Location, visible: readonly RouteDef[]): Resolution {
  const known = ROUTES.find((r) => r.path === loc.path[0])
  if (known) return visible.some((v) => v.id === known.id) ? { kind: 'screen', route: known } : { kind: 'forbidden', route: known }
  const first = visible[0]
  return first ? { kind: 'redirect', to: hashFor(first) } : { kind: 'none' }
}
