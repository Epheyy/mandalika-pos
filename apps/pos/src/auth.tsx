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
import { defaultKV, getKV, getOutboxStore } from '@mandalika/sync'
import { openCartKey } from './cashier/openCartDraft'
import { api, authStore } from './api'
import {
  checkLoginAllowed,
  clearBinding,
  clearOutletCaches,
  isQueueReleasable,
  readBinding,
  readQueueState,
  resolveTerminal,
  sameBinding,
  writeBinding,
  type TerminalState,
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
  /** How the signed-in account relates to this terminal: ok, an admin must pick the outlet once,
   *  a non-admin has no outlet (unassigned) or one different from the terminal's (mismatch). Null
   *  when nobody is signed in. Anything but "ok" blocks the cashier screen. */
  terminalState: TerminalState | null
  login: (email: string, password: string) => Promise<void>
  /** One-time terminal outlet pick for an outlet-less account; durable before it resolves. */
  pickOutlet: (outlet: { id: string; name: string }) => Promise<void>
  /** Free the terminal (clear the binding) and sign out. Refused unless the queue is empty. */
  releaseTerminal: () => Promise<void>
  logout: () => void
}

const logBindingFailure = (err: unknown) => console.error('[terminal] binding write failed', err)

const AuthCtx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [terminalState, setTerminalState] = useState<TerminalState | null>(null)

  const clear = useCallback(() => {
    // P-20: an open cart never outlives its session (logout, expiry, release): the next sign-in starts clean.
    // The outlet comes from the terminal binding: on a boot-time rejection authStore.outletId is not set yet.
    void getKV().removeDurable(openCartKey(readBinding(getKV())?.outletId ?? authStore.outletId ?? '')).catch(() => {})
    authStore.access = null
    authStore.refresh = null
    authStore.outletId = null
    authStore.userId = null
    authStore.shiftId = null
    dropSession() // the terminal binding is deliberately NOT part of the session
    setTerminalState(null)
    setUser(null)
  }, [])

  // The outlet a request/capture uses ALWAYS comes from the terminal binding: boot, offline
  // restore, sign-in and token refresh all go through here (A04). It only ever CREATES a
  // binding on an unbound terminal; a bound terminal is never rebound here (a non-admin whose
  // outlet differs is a "mismatch": no outlet, so actor() refuses and requests carry no
  // outlet, until "Lepas terminal"). `fresh` (sign-in / pick, not boot or token refresh) also
  // clears the previous outlet's cached data when a new binding is created. Resolves once the
  // binding is durable; callers that must not proceed without it await it.
  const settleTerminal = useCallback((u: User, opts: { picked?: { id: string; name: string }; fresh?: boolean } = {}): Promise<void> => {
    const kv = getKV()
    const current = readBinding(kv)
    const res = resolveTerminal(u, current, opts.picked)
    authStore.userId = u.id
    authStore.outletId = res.state === 'ok' && res.binding ? res.binding.outletId : null
    setTerminalState(res.state)
    if (res.state !== 'ok' || !res.binding) return Promise.resolve()
    if (res.created && opts.fresh) clearOutletCaches(kv, res.binding.outletId)
    return sameBinding(current, res.binding) ? Promise.resolve() : writeBinding(kv, res.binding)
  }, [])

  const apply = useCallback((d: { access: string; refresh: string; user: User }, fresh = false): Promise<void> => {
    authStore.access = d.access
    authStore.refresh = d.refresh
    const settled = settleTerminal(d.user, { fresh })
    persistSession(d)
    setUser(d.user)
    return settled
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
        void settleTerminal(d.user).catch(logBindingFailure)
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
        if (r.kind === 'signed-in') void apply(r.data).catch(logBindingFailure)
        else if (r.kind === 'offline') {
          authStore.refresh = r.refresh
          void settleTerminal(r.user).catch(logBindingFailure)
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
      // account's queued transactions (A04). Revoke the session just issued.
      const verdict = checkLoginAllowed(getOutboxStore(), d.user)
      if (!verdict.ok) {
        void api.logout(d.refresh).catch(() => {})
        throw new Error(verdict.message)
      }
      try {
        await apply(d, true) // the binding is durable before the sign-in completes
      } catch (err) {
        logBindingFailure(err)
        void api.logout(d.refresh).catch(() => {})
        throw new Error('Pengaturan terminal gagal tersimpan di perangkat. Coba masuk lagi.')
      }
    },
    [apply],
  )

  const pickOutlet = useCallback(
    async (outlet: { id: string; name: string }) => {
      if (!user) throw new Error('Belum masuk')
      await settleTerminal(user, { picked: outlet, fresh: true }) // durable first
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
    if (!isQueueReleasable(readQueueState(getOutboxStore()))) {
      throw new Error('Masih ada transaksi yang belum terkirim atau perlu ditinjau tanpa pemilik. Terminal tidak dapat dilepas.')
    }
    const bound = readBinding(kv)
    await clearBinding(kv)
    clearOutletCaches(kv, bound?.outletId)
    logout()
  }, [logout])

  const value = useMemo<AuthState>(
    () => ({ user, ready, terminalState, login, pickOutlet, releaseTerminal, logout }),
    [user, ready, terminalState, login, pickOutlet, releaseTerminal, logout],
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthState {
  const ctx = use(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
