import { ROLE } from '../../lib/labels/role'

export type Role = 'admin' | 'manager' | 'cashier'
export const ROLES: readonly Role[] = ['admin', 'manager', 'cashier']
export const ROLE_LABEL: Record<Role, string> = { admin: ROLE.admin.label, manager: ROLE.manager.label, cashier: ROLE.cashier.label }
