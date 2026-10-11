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
  bindingFor,
  checkLoginAllowed,
  clearBinding,
  clearOutletCaches,
  isQueueEmpty,
  readBinding,
  readQueueState,
  sameBinding,
  writeBinding,
} from './terminalBinding'
import {
  BOOT_REFRESH_TIMEOUT_MS,
  REFRESH_KEY,
  bootSession,
  dropSession,
  persistSession,
} from './authBoot'

// KV access goes through authBoot, which resolves getKV() at call time: main.tsx
// swaps it to the secure (Preferences) store AFTER this module is loaded.

// Any role may sign into the POS. The earlier cashier-only gate blocked
// manager/admin accounts from operating a register, which broke the realistic
// case of a single staff member who both sells and approves SP3 receives
// (promoting their role to manager so their PIN works would otherwise lock
// them out of the POS). The server still authenticates the credentials; the
// SP3 manager step-up PIN flow handles approval-time authorization separately.

interface AuthState {
  user: User | null
  ready: boolean
  /** Signed in as an outlet-less ADMIN on a terminal with no outlet yet: must pick once. */
  needsOutletPick: boolean
  /** Signed in as a non-admin account with no outlet: it cannot operate a terminal at all. */
  outletUnassigned: boolean
  login: (email: string, password: string) => Promise<void>
  /** One-time terminal outlet pick for an outlet-less account; durable before it resolves. */
  pickOutlet: (outlet: { id: string; name: string }) => Promise<void>
  /** Free the terminal (clear the binding) and sign out. Refused unless the queue is empty. */
  releaseTerminal: () => Promise<void>
  logout: () => void
}

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [needsOutletPick, setNeedsOutletPick] = useState(false)
  const [outletUnassigned, setOutletUnassigned] = useState(false)

  const clear = useCallback(() => {
    authStore.access = null
    authStore.refresh = null
    authStore.outletId = null
    authStore.userId = null
    authStore.shiftId = null
    dropSession() // the terminal binding is deliberately NOT part of the session
    setNeedsOutletPick(false)
    setOutletUnassigned(false)
    setUser(null)
  }, [])

  // The outlet a request/capture uses ALWAYS comes from the terminal binding: boot,
  // offline restore, sign-in and token refresh all go through here (A04). The binding
  // is rewritten when the account (and so the owner) or its stored outlet changed.
  const settleTerminal = useCallback((u: User, picked?: { id: string; name: string }) => {
    const kv = getKV()
    const current = readBinding(kv)
    const next = bindingFor(u, current, picked)
    authStore.userId = u.id
    authStore.outletId = next?.outletId ?? null
    setNeedsOutletPick(next === null && u.role === 'admin')
    setOutletUnassigned(next === null && u.role !== 'admin')
    if (next && !sameBinding(current, next)) {
      writeBinding(kv, next).catch((err) => console.error('[terminal] binding write failed', err))
    }
  }, [])

  const apply = useCallback((d: { access: string; refresh: string; user: User }) => {
    authStore.access = d.access
    authStore.refresh = d.refresh
    settleTerminal(d.user)
    persistSession(d)
    setUser(d.user)
  }, [settleTerminal])

  useEffect(() => {
    authStore.onUnauthorized = clear
    // Silent refresh persists rotated tokens; the POS session then lives
    // until the cashier explicitly logs out (refresh TTL is long server-side).
    authStore.onTokens = (d) => {
      // A refresh that resolves after logout must not sign the cashier back in.
      if (authStore.refresh === null) return
      authStore.access = d.access
      authStore.refresh = d.refresh
      persistSession(d)
      // Replaces an offline-restored cached profile once the session renews.
      if (d.user) {
        settleTerminal(d.user)
        setUser(d.user)
      }
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
          settleTerminal(r.user)
          setUser(r.user)
        } else if (r.kind === 'login-keep-token') {
          authStore.refresh = r.refresh
        } else if (r.kind === 'rejected') clear()
      })
      .catch(() => {
        // Unexpected storage failure: do not drop the stored token.
      })
      .finally(() => setReady(true))
  }, [clear, apply, settleTerminal])

  const login = useCallback(
    async (email: string, password: string) => {
      const d = await api.login(email, password)
      // A different account may not take over a terminal that still holds the previous
      // account's queued / in-review transactions (A04). Revoke the session just issued.
      const verdict = checkLoginAllowed(getKV(), d.user)
      if (!verdict.ok) {
        void api.logout(d.refresh).catch(() => {})
        throw new Error(verdict.message)
      }
      apply(d)
    },
    [apply],
  )

  const pickOutlet = useCallback(
    async (outlet: { id: string; name: string }) => {
      if (!user) throw new Error('Belum masuk')
      const next = bindingFor(user, readBinding(getKV()), outlet)
      if (!next) throw new Error('Outlet tidak valid')
      await writeBinding(getKV(), next) // durable first: only then does the terminal act as that outlet
      settleTerminal(user, outlet)
    },
    [user, settleTerminal],
  )

  const logout = useCallback(() => {
    const refresh = getKV().get(REFRESH_KEY)
    if (refresh) void api.logout(refresh).catch(() => {})
    clear()
  }, [clear])

  const releaseTerminal = useCallback(async () => {
    const kv = getKV()
    if (!isQueueEmpty(readQueueState(kv))) {
      throw new Error('Masih ada transaksi yang belum terkirim atau perlu ditinjau. Terminal tidak dapat dilepas.')
    }
    await clearBinding(kv)
    clearOutletCaches(kv)
    logout()
  }, [logout])

  const value = useMemo<AuthState>(
    () => ({ user, ready, needsOutletPick, outletUnassigned, login, pickOutlet, releaseTerminal, logout }),
    [user, ready, needsOutletPick, outletUnassigned, login, pickOutlet, releaseTerminal, logout],
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthState {
  const ctx = use(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
