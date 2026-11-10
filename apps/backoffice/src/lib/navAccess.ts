/** Whether a signed-in user sees a backoffice nav tab. Pure so it can be tested (A37: Log Error is admin-only). */
export interface NavUser {
  role: string
  outletId?: string | null
  permissions?: string[]
}

/** The server lets only the admin edit any outlet; anyone else may edit their own outlet only (PUT /outlets/{id}). */
export function canEditOutlet(user: NavUser | null, outletId: string): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return !!user.outletId && user.outletId.toLowerCase() === outletId.toLowerCase()
}

export function canSeeNav(id: string, perm: string, user: NavUser | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  // Admin-only: no permission grants these (the server enforces admin-only anyway; /users and /custom-roles are admin-only).
  if (id === 'errors' || id === 'erpOutbox' || id === 'users') return false
  const perms = user.permissions || []
  if (id === 'warehouses' || id === 'approvals') return perms.includes('manage_inventory') || perms.includes('manage_stock_count')
  if (id === 'requisitions') return perms.includes('request_stock') || perms.includes('manage_inventory')
  if (id === 'reports') return perms.includes('view_reports') || perms.includes('view_transactions')
  return perms.includes(perm)
}
