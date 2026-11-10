import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@mandalika/api'
import { api, authStore } from './api'
import { productCatalogue } from './lib/productCatalogue'
import { localDay } from './lib/businessDay'

const REFRESH_KEY = 'mandalika.backoffice.refresh'
// Backoffice sessions are day-bound: a new calendar day forces re-login.
const LOGIN_DATE_KEY = 'mandalika.backoffice.loginDate'
const today = () => localDay()

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
    authStore.refresh = null
    authStore.userId = null
    productCatalogue.clear()
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(LOGIN_DATE_KEY)
    setUser(null)
  }, [])

  useEffect(() => {
    authStore.onUnauthorized = clear
    // Silent refresh keeps the admin signed in through the working day.
    authStore.onTokens = (d) => {
      authStore.access = d.access
      authStore.refresh = d.refresh
      localStorage.setItem(REFRESH_KEY, d.refresh)
    }
    const refresh = localStorage.getItem(REFRESH_KEY)
    const loginDate = localStorage.getItem(LOGIN_DATE_KEY)
    if (!refresh) {
      setReady(true)
      return
    }
    // Day-bound: a refresh from a previous calendar day is not honored.
    if (loginDate !== today()) {
      clear()
      setReady(true)
      return
    }
    authStore.refresh = refresh
    api
      .refresh(refresh)
      .then((d) => {
        if (!ALLOWED_ROLES.has(d.user.role)) {
          clear()
          return
        }
        authStore.access = d.access
        authStore.refresh = d.refresh
        localStorage.setItem(REFRESH_KEY, d.refresh)
        authStore.userId = d.user.id
        setUser(d.user)
      })
      .catch(() => clear())
      .finally(() => setReady(true))
  }, [clear])

  // While the tab stays open across midnight, enforce the day boundary on
  // focus/visibility so a stale session can't continue into a new day.
  useEffect(() => {
    const check = () => {
      const ld = localStorage.getItem(LOGIN_DATE_KEY)
      if (ld && ld !== today()) {
        const r = localStorage.getItem(REFRESH_KEY)
        if (r) void api.logout(r).catch(() => {})
        clear()
      }
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [clear])

  const login = useCallback(async (email: string, password: string) => {
    const d = await api.login(email, password)
    if (!ALLOWED_ROLES.has(d.user.role)) {
      throw new Error('Akun ini akun kasir. Masuk lewat aplikasi POS.')
    }
    authStore.access = d.access
    authStore.refresh = d.refresh
    localStorage.setItem(REFRESH_KEY, d.refresh)
    localStorage.setItem(LOGIN_DATE_KEY, today())
    authStore.userId = d.user.id
    productCatalogue.clear()
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
  const ctx = use(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
