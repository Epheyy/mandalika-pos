/** Whether a signed-in user sees a backoffice nav tab. Pure so it can be tested (A37: Log Error is admin-only). */
export interface NavUser {
  role: string
  permissions?: string[]
}

export function canSeeNav(id: string, perm: string, user: NavUser | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  // Admin-only: no permission grants the error log tab (the server enforces admin-only anyway).
  if (id === 'errors' || id === 'erpOutbox') return false
  const perms = user.permissions || []
  if (id === 'warehouses') return perms.includes('manage_inventory') || perms.includes('manage_stock_count')
  if (id === 'reports') return perms.includes('view_reports') || perms.includes('view_transactions')
  return perms.includes(perm)
}
