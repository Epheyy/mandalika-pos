import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@mandalika/api'
import { api, authStore } from './api'

const REFRESH_KEY = 'mandalika.pos.refresh'

// POS is Cashier only. Admin/Manager must use the Backoffice app.
const ALLOWED_ROLES = new Set(['cashier'])

interface AuthState {
  user: User | null
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  const clear = useCallback(() => {
    authStore.access = null
    authStore.outletId = null
    localStorage.removeItem(REFRESH_KEY)
    setUser(null)
  }, [])

  const apply = useCallback((d: { access: string; refresh: string; user: User }) => {
    authStore.access = d.access
    authStore.outletId = d.user.outletId ?? null
    localStorage.setItem(REFRESH_KEY, d.refresh)
    setUser(d.user)
  }, [])

  useEffect(() => {
    authStore.onUnauthorized = clear
    const refresh = localStorage.getItem(REFRESH_KEY)
    if (!refresh) {
      setReady(true)
      return
    }
    api
      .refresh(refresh)
      .then((d) => {
        if (!ALLOWED_ROLES.has(d.user.role)) {
          clear()
          return
        }
        apply(d)
      })
      .catch(() => clear())
      .finally(() => setReady(true))
  }, [clear, apply])

  const login = useCallback(
    async (email: string, password: string) => {
      const d = await api.login(email, password)
      if (!ALLOWED_ROLES.has(d.user.role)) {
        throw new Error('This account is not a cashier. Use the Backoffice app.')
      }
      apply(d)
    },
    [apply],
  )

  const logout = useCallback(() => {
    const refresh = localStorage.getItem(REFRESH_KEY)
    if (refresh) void api.logout(refresh).catch(() => {})
    clear()
  }, [clear])

  const value = useMemo<AuthState>(
    () => ({ user, ready, login, logout }),
    [user, ready, login, logout],
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
