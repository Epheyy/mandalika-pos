import type { User } from '@mandalika/api'
import { outletCoverageOf } from './outletCoverage'
/** Whether a signed-in user sees a backoffice nav tab. Pure so it can be tested (A37: Log Error is admin-only). */
export interface NavUser {
  role: string
  outletId?: string | null
  outletIds?: string[]
  allOutlets?: boolean
  permissions?: string[]
}

/** The server lets the admin and an All manager edit any outlet; anyone else only the outlets they cover (PUT /outlets/{id}). */
export function canEditOutlet(user: NavUser | null, outletId: string): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  const cov = outletCoverageOf({ ...user, role: user.role as User['role'], outletId: user.outletId ?? null })
  if (cov.allOutlets) return true
  const id = outletId.toLowerCase()
  return cov.outletIds.some((o) => o.toLowerCase() === id)
}

export function canSeeNav(id: string, perm: string, user: NavUser | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  // Admin-only: no permission grants these (the server enforces admin-only anyway; /users and /custom-roles are admin-only).
  if (id === 'errors' || id === 'crossLookups' || id === 'erpOutbox' || id === 'users') return false
  const perms = user.permissions || []
  if (id === 'warehouses' || id === 'approvals') return perms.includes('manage_inventory') || perms.includes('manage_stock_count')
  if (id === 'requisitions') return perms.includes('request_stock') || perms.includes('manage_inventory')
  if (id === 'reports') return perms.includes('view_reports') || perms.includes('view_transactions')
  return perms.includes(perm)
}

/** Whether the Backoffice offers the void actions (the server enforces `void_any`; the UI only hides). */
export function canVoidAny(user: NavUser | null): boolean {
  if (!user) return false
  return user.role === 'admin' || (user.permissions ?? []).includes('void_any')
}

/** Mirrors the server's catalogue-write rule (auth.CatalogueWide): the admin, or a manager covering all outlets. Everyone else sees the catalogue view-only. */
export function canEditCatalogue(user: NavUser | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.role === 'manager' && user.allOutlets === true
}
