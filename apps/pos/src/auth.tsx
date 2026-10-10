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
import { defaultKV, getKV } from '@mandalika/sync'
import { api, authStore } from './api'
import {
  BOOT_REFRESH_TIMEOUT_MS,
  REFRESH_KEY,
  bootSession,
  cacheUser,
  clearSession,
} from './authBoot'

// Resolve the KV at use time, never at import: main.tsx swaps getKV() to the
// secure (Preferences) store AFTER this module is loaded.

// Any role may sign into the POS. The earlier cashier-only gate blocked
// manager/admin accounts from operating a register, which broke the realistic
// case of a single staff member who both sells and approves SP3 receives
// (promoting their role to manager so their PIN works would otherwise lock
// them out of the POS). The server still authenticates the credentials; the
// SP3 manager step-up PIN flow handles approval-time authorization separately.

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
    authStore.outletId = null
    clearSession(getKV())
    setUser(null)
  }, [])

  const apply = useCallback((d: { access: string; refresh: string; user: User }) => {
    authStore.access = d.access
    authStore.refresh = d.refresh
    authStore.outletId = d.user.outletId ?? null
    const kv = getKV()
    kv.set(REFRESH_KEY, d.refresh)
    cacheUser(kv, d.user)
    setUser(d.user)
  }, [])

  useEffect(() => {
    authStore.onUnauthorized = clear
    // Silent refresh persists rotated tokens; the POS session then lives
    // until the cashier explicitly logs out (refresh TTL is long server-side).
    authStore.onTokens = (d) => {
      authStore.access = d.access
      authStore.refresh = d.refresh
      authStore.outletId = d.user?.outletId ?? authStore.outletId
      const kv = getKV()
      kv.set(REFRESH_KEY, d.refresh)
      if (d.user) cacheUser(kv, d.user)
    }
    // Only a server 401 ends the session. Offline / timeout / 5xx keeps the
    // token and restores the cached user; the first sync request then 401s
    // (no access token yet) and the client's silent refresh renews it online.
    void bootSession(getKV(), defaultKV, (t) =>
      api.refresh(t, { timeoutMs: BOOT_REFRESH_TIMEOUT_MS }),
    )
      .then((r) => {
        if (r.kind === 'signed-in') apply(r.data)
        else if (r.kind === 'offline') {
          authStore.refresh = r.refresh
          authStore.outletId = r.user.outletId ?? null
          setUser(r.user)
        } else if (r.kind === 'login-keep-token') {
          authStore.refresh = getKV().get(REFRESH_KEY)
        } else if (r.kind === 'rejected') clear()
      })
      .catch(() => {
        // Unexpected storage failure: do not drop the stored token.
      })
      .finally(() => setReady(true))
  }, [clear, apply])

  const login = useCallback(
    async (email: string, password: string) => {
      const d = await api.login(email, password)
      apply(d)
    },
    [apply],
  )

  const logout = useCallback(() => {
    const refresh = getKV().get(REFRESH_KEY)
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
