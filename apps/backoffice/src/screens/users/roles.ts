import { ROLE } from '../../lib/labels/role'

/** What blocks saving a custom role, or null. A role needs a name and at least one permission (mirrors the server). */
export function roleFormProblem(form: { name: string; permissions: readonly string[] }): string | null {
  if (!form.name.trim()) return 'Nama role wajib diisi.'
  if (form.permissions.length === 0) return 'Pilih minimal 1 izin'
  return null
}

export type Role = 'admin' | 'manager' | 'cashier'
export const ROLES: readonly Role[] = ['admin', 'manager', 'cashier']
export const ROLE_LABEL: Record<Role, string> = { admin: ROLE.admin.label, manager: ROLE.manager.label, cashier: ROLE.cashier.label }
