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

const REFRESH_KEY = 'mandalika.backoffice.refresh'

// Backoffice is Admin/Manager only. Cashiers must use the POS app.
const ALLOWED_ROLES = new Set(['admin', 'manager'])

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
    localStorage.removeItem(REFRESH_KEY)
    setUser(null)
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
        authStore.access = d.access
        localStorage.setItem(REFRESH_KEY, d.refresh)
        setUser(d.user)
      })
      .catch(() => clear())
      .finally(() => setReady(true))
  }, [clear])

  const login = useCallback(async (email: string, password: string) => {
    const d = await api.login(email, password)
    if (!ALLOWED_ROLES.has(d.user.role)) {
      throw new Error('This account is a cashier. Use the POS app to sign in.')
    }
    authStore.access = d.access
    localStorage.setItem(REFRESH_KEY, d.refresh)
    setUser(d.user)
  }, [])

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
