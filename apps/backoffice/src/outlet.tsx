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
import { activeOutletOf, outletCoverageOf, restoreChoice } from './lib/outletCoverage'
import { readOutletPref, writeOutletPref } from './lib/outletPref'

interface OutletState {
  /** Chosen outlet id, or null = no override: the combined view for admin / All manager, else the home outlet. */
  outletId: string | null
  setOutletId: (id: string | null) => void
  outlets: Outlet[]
  isAdmin: boolean
  /** Admin, an All manager, or a manager covering two or more outlets. */
  canSwitch: boolean
  /** May choose the combined "Semua outlet" view (admin or All manager). */
  allowCombined: boolean
  /** False for a switching user until the first outlet list has arrived (or failed), so the saved scope is applied before screens fetch. */
  outletsReady: boolean
  /** Re-fetch the outlet list (e.g. right after creating an outlet). */
  refreshOutlets: () => void
}

const OutletCtx = createContext<OutletState | null>(null)

// A switching user must not sit on the loading screen for good when the outlet list never answers.
const OUTLETS_READY_FALLBACK_MS = 8000

export function OutletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const { outletIds, allOutlets, canSwitch, allowCombined } = outletCoverageOf(user)
  // Stable key for the callbacks below: the covered ids as one string, not a fresh array every render.
  const coverageKey = outletIds.join(',')
  const userId = user?.id ?? null
  const [outletId, setOutletIdState] = useState<string | null>(null)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  // Which user the outlet list has arrived for. Readiness is derived in render (not set in an effect), so a
  // second login in the same tab is never "ready" for a render before its saved scope has been applied.
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const outletsReady = !canSwitch || (userId !== null && readyFor === userId)

  const setOutletId = useCallback(
    (id: string | null) => {
      authStore.outletId = id
      setOutletIdState(id)
      // Remembered per viewer (D-69): the scope is global state, not part of the URL.
      if (userId) writeOutletPref(userId, id)
    },
    [userId],
  )

  // The coverage slice of the user, stable across silent refreshes that change nothing about it.
  const role = user?.role
  const homeOutletId = user?.outletId ?? null
  const coverageUser = useMemo(
    () => (role ? { role, outletId: homeOutletId, outletIds: coverageKey.split(',').filter(Boolean), allOutlets } : null),
    [role, homeOutletId, coverageKey, allOutlets],
  )

  const refreshOutlets = useCallback(() => {
    if (!canSwitch) return
    api
      .listOutlets()
      .then((list) => setOutlets(restoreChoice(coverageUser, list, null).outlets))
      .catch(() => {})
  }, [canSwitch, coverageUser])

  useEffect(() => {
    // Admin / All manager: cross-outlet by default (no X-Outlet-Id), or the outlet this viewer last chose.
    // Covered manager: the home outlet by default (no header), or a remembered covered outlet. Everyone else:
    // the token's own outlet governs scope server-side, so leave the header unset.
    authStore.outletId = null
    setOutletIdState(null)
    setReadyFor(null)
    if (!canSwitch) {
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
        // Resolved against the covered list only: a remembered outlet outside coverage is dropped, never sent.
        const { outlets: covered, outletId: saved, stale } = restoreChoice(coverageUser, list, userId ? readOutletPref(userId) : null)
        setOutlets(covered)
        if (stale && userId) writeOutletPref(userId, null)
        if (saved) {
          authStore.outletId = saved
          setOutletIdState(saved)
        }
      })
      .catch(() => {})
      .finally(() => {
        // Ready even when the list failed: screens then load with the default scope, as before.
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
  }, [canSwitch, userId, refreshOutlets, coverageUser])

  const value = useMemo<OutletState>(
    () => ({ outletId, setOutletId, outlets, isAdmin, canSwitch, allowCombined, outletsReady, refreshOutlets }),
    [outletId, setOutletId, outlets, isAdmin, canSwitch, allowCombined, outletsReady, refreshOutlets],
  )
  return <OutletCtx.Provider value={value}>{children}</OutletCtx.Provider>
}

export function useOutlet(): OutletState {
  const ctx = use(OutletCtx)
  if (!ctx) throw new Error('useOutlet must be used within OutletProvider')
  return ctx
}

/**
 * The outlet requests are scoped to: the switcher choice, else the user's home outlet. For admin / All manager
 * with no choice it is null (the combined view), as the server treats a missing X-Outlet-Id for them.
 */
export function useActiveOutletId(): string | null {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  return activeOutletOf(outletId, user)
}

export function OutletSwitcher() {
  const { user } = useAuth()
  const { outletId, setOutletId, outlets, canSwitch, allowCombined } = useOutlet()
  // A covered manager has no combined view: with no choice the select shows the home outlet.
  const selected = outletId ?? (allowCombined ? '' : (user?.outletId ?? ''))
  return (
    <OutletSwitcherView
      show={canSwitch}
      outlets={outlets}
      selected={selected}
      allowCombined={allowCombined}
      onChange={setOutletId}
    />
  )
}

interface OutletSwitcherViewProps {
  show: boolean
  outlets: Outlet[]
  selected: string
  allowCombined: boolean
  onChange: (id: string | null) => void
}

/** The switcher markup, apart from the context so it renders standalone (tests). */
export function OutletSwitcherView({ show, outlets, selected, allowCombined, onChange }: OutletSwitcherViewProps) {
  if (!show || outlets.length === 0) return null
  // A filled paper pill with a muted "Cakupan" prefix (SH-04). The prefix is decoration: the select keeps its own name.
  return (
    <label className="relative inline-flex h-10 min-w-0 items-center gap-2 rounded-xl bg-paper-1 pl-3 pr-2 text-[13px] focus-within:ring-2 focus-within:ring-brand-strong">
      <span aria-hidden="true" className="text-xs font-medium text-ink-700 max-sm:hidden">
        Cakupan
      </span>
      <select
        aria-label="Cakupan outlet"
        value={selected}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-full min-w-0 max-w-32 cursor-pointer appearance-none truncate bg-transparent pr-5 text-[13px] font-semibold text-ink-900 focus:outline-none sm:max-w-48"
      >
        {allowCombined && <option value="">Semua outlet</option>}
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
