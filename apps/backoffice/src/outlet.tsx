import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ChevronDown } from 'lucide-react'
import type { Outlet } from '@mandalika/api'
import { api, authStore } from './api'
import { useAuth } from './auth'
import { readOutletPref, resolveOutletPref, writeOutletPref } from './lib/outletPref'

interface OutletState {
  /** Active outlet id, or null = "all outlets" (admin cross-outlet view). */
  outletId: string | null
  setOutletId: (id: string | null) => void
  outlets: Outlet[]
  isAdmin: boolean
  /** False for an admin until the first outlet list has arrived (or failed), so the saved scope is applied before screens fetch. */
  outletsReady: boolean
  /** Re-fetch the outlet list (e.g. right after creating an outlet). */
  refreshOutlets: () => void
}

const OutletCtx = createContext<OutletState | null>(null)

// An admin must not sit on the loading screen for good when the outlet list never answers.
const OUTLETS_READY_FALLBACK_MS = 8000

export function OutletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const userId = user?.id ?? null
  const [outletId, setOutletIdState] = useState<string | null>(null)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  // Which admin the outlet list has arrived for. Readiness is derived in render (not set in an effect), so a
  // second login in the same tab is never "ready" for a render before its saved scope has been applied.
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const outletsReady = !isAdmin || (userId !== null && readyFor === userId)

  const setOutletId = useCallback(
    (id: string | null) => {
      authStore.outletId = id
      setOutletIdState(id)
      // Remembered per viewer (D-69): the scope is global state, not part of the URL.
      if (userId) writeOutletPref(userId, id)
    },
    [userId],
  )

  const refreshOutlets = useCallback(() => {
    if (!isAdmin) return
    api
      .listOutlets()
      .then(setOutlets)
      .catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    // Admin: cross-outlet by default (no X-Outlet-Id), or the outlet this viewer last chose. Non-admin: the
    // token's own outlet governs scope server-side, so leave the header unset.
    authStore.outletId = null
    setOutletIdState(null)
    setReadyFor(null)
    if (!isAdmin) {
      setOutlets([])
      return
    }
    let cancelled = false
    const markReady = () => {
      if (!cancelled) setReadyFor(userId)
    }
    const fallback = setTimeout(markReady, OUTLETS_READY_FALLBACK_MS)
    api
      .listOutlets()
      .then((list) => {
        if (cancelled) return
        setOutlets(list)
        const { outletId: saved, stale } = resolveOutletPref(userId ? readOutletPref(userId) : null, list)
        if (stale && userId) writeOutletPref(userId, null)
        if (saved) {
          authStore.outletId = saved
          setOutletIdState(saved)
        }
      })
      .catch(() => {})
      .finally(() => {
        // Ready even when the list failed: screens then load cross-outlet, as before.
        markReady()
      })
    // Poll + refresh on focus so a newly created outlet shows in the switcher
    // without a hard refresh.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshOutlets()
    }, 15000)
    const onFocus = () => refreshOutlets()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimeout(fallback)
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [isAdmin, userId, refreshOutlets])

  const value = useMemo<OutletState>(
    () => ({ outletId, setOutletId, outlets, isAdmin, outletsReady, refreshOutlets }),
    [outletId, setOutletId, outlets, isAdmin, outletsReady, refreshOutlets],
  )
  return <OutletCtx.Provider value={value}>{children}</OutletCtx.Provider>
}

export function useOutlet(): OutletState {
  const ctx = use(OutletCtx)
  if (!ctx) throw new Error('useOutlet must be used within OutletProvider')
  return ctx
}

export function OutletSwitcher() {
  const { outletId, setOutletId, outlets, isAdmin } = useOutlet()
  if (!isAdmin || outlets.length === 0) return null
  // A filled paper pill with a muted "Cakupan" prefix (SH-04). The prefix is decoration: the select keeps its own name.
  return (
    <label className="relative inline-flex h-10 min-w-0 items-center gap-2 rounded-xl bg-paper-1 pl-3 pr-2 text-[13px] focus-within:ring-2 focus-within:ring-brand-strong">
      <span aria-hidden="true" className="text-xs font-medium text-ink-700 max-sm:hidden">
        Cakupan
      </span>
      <select
        aria-label="Cakupan outlet"
        value={outletId ?? ''}
        onChange={(e) => setOutletId(e.target.value || null)}
        className="h-full min-w-0 max-w-32 cursor-pointer appearance-none truncate bg-transparent pr-5 text-[13px] font-semibold text-ink-900 focus:outline-none sm:max-w-48"
      >
        <option value="">Semua outlet</option>
        {outlets.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 h-4 w-4 text-ink-700" />
    </label>
  )
}

/** Like useOutlet, but null outside an OutletProvider. For kit parts that must also render standalone (tests, server markup). */
export function useOptionalOutlet(): OutletState | null {
  return use(OutletCtx)
}
