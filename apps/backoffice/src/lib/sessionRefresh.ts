import type { AuthData, User } from '@mandalika/api'
import type { authStore } from '../api'

// Backoffice is Admin/Manager only. Cashiers must use the POS app.
export const ALLOWED_ROLES = new Set(['admin', 'manager'])

export interface RefreshDeps {
  store: typeof authStore
  persist: (refresh: string) => void
  setUser: (u: User) => void
  clear: () => void
}

/**
 * Adopts the tokens and user of a silent refresh, so a rights change made by an admin
 * takes effect without a re-login. Outcomes:
 * - "kept": the session continues with the refreshed user (new role, permissions, outlet);
 * - "signed-out": the refreshed role may no longer use the Backoffice (nothing is persisted);
 * - "ignored": the session was already ended (a refresh that lands after logout).
 */
export function applyRefreshedSession(d: AuthData, deps: RefreshDeps): 'kept' | 'signed-out' | 'ignored' {
  const { store, persist, setUser, clear } = deps
  // A refresh that resolves after logout must not sign the user back in.
  if (store.refresh === null) return 'ignored'
  if (!ALLOWED_ROLES.has(d.user.role)) {
    clear()
    return 'signed-out'
  }
  store.access = d.access
  store.refresh = d.refresh
  store.userId = d.user.id
  persist(d.refresh)
  setUser(d.user)
  // Only an admin may override the outlet. Reset it here so the immediate retry carries
  // no stale admin X-Outlet-Id (OutletProvider resets it too, but only after render).
  if (d.user.role !== 'admin') store.outletId = null
  return 'kept'
}
