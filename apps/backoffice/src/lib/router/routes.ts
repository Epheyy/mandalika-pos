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
}

export const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'penjualan', label: 'Penjualan' },
  { id: 'pelanggan', label: 'Pelanggan' },
  { id: 'produk-stok', label: 'Produk & Stok' },
  { id: 'operasional', label: 'Operasional' },
  { id: 'sistem', label: 'Sistem' },
]

// Order here is the order in the sidebar inside each section (D-16).
export const ROUTES: readonly RouteDef[] = [
  { id: 'dashboard', path: 'ringkasan', label: 'Dashboard', section: 'penjualan', icon: LayoutDashboard, perm: 'view_dashboard', load: () => import('../../screens/Dashboard') },
  { id: 'reports', path: 'laporan', label: 'Laporan', section: 'penjualan', icon: BarChart3, perm: 'view_reports', load: () => import('../../screens/Reports') },
  { id: 'customers', path: 'pelanggan', label: 'Pelanggan', section: 'pelanggan', icon: UsersIcon, perm: 'manage_customers', load: () => import('../../screens/Customers') },
  { id: 'promotions', path: 'promosi', label: 'Promosi', section: 'pelanggan', icon: Tag, perm: 'manage_promotions', load: () => import('../../screens/Promotions') },
  { id: 'products', path: 'produk', label: 'Produk', section: 'produk-stok', icon: Package, perm: 'manage_products', load: () => import('../../screens/Products') },
  { id: 'warehouses', path: 'inventori', label: 'Inventori', section: 'produk-stok', icon: Warehouse, perm: 'manage_inventory', load: () => import('../../screens/Warehouses') },
  { id: 'approvals', path: 'persetujuan-stok', label: 'Persetujuan Stok', section: 'produk-stok', icon: ClipboardCheck, perm: 'manage_inventory', load: () => import('../../screens/approvals/ApprovalQueue') },
  { id: 'requisitions', path: 'permintaan-barang', label: 'Permintaan Barang', section: 'produk-stok', icon: ClipboardList, perm: 'request_stock', load: () => import('../../screens/requisitions/RequisitionList') },
  { id: 'users', path: 'pengguna', label: 'Pengguna', section: 'operasional', icon: UserCog, perm: 'manage_users', load: () => import('../../screens/Users') },
  { id: 'syncReview', path: 'tinjauan-sinkron', label: 'Tinjauan Sinkron', section: 'operasional', icon: ClipboardCheck, perm: 'resolve_sync_review', load: () => import('../../screens/syncReview/SyncReview') },
  { id: 'settings', path: 'pengaturan', label: 'Pengaturan', section: 'operasional', icon: Settings, perm: 'manage_settings', load: () => import('../../screens/SettingsScreen') },
  // Admin-only: no role is granted 'manage_erp_integration'; the endpoints are admin-gated server-side.
  { id: 'erpOutbox', path: 'integrasi-erp', label: 'Integrasi ERP', section: 'sistem', icon: Cable, perm: 'manage_erp_integration', load: () => import('../../screens/integration/ErpOutboxScreen') },
  // Admin-only: 'view_error_logs' isn't granted to any role, so it shows only via the isAdmin bypass.
  { id: 'errors', path: 'log-kesalahan', label: 'Log Error', section: 'sistem', icon: AlertTriangle, perm: 'view_error_logs', load: () => import('../../screens/ErrorLogs') },
]

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
