import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Outlet } from '@mandalika/api'
import { api, authStore } from './api'
import { useAuth } from './auth'

interface OutletState {
  /** Active outlet id, or null = "all outlets" (admin cross-outlet view). */
  outletId: string | null
  setOutletId: (id: string | null) => void
  outlets: Outlet[]
  isAdmin: boolean
  /** Re-fetch the outlet list (e.g. right after creating an outlet). */
  refreshOutlets: () => void
}

const OutletCtx = createContext<OutletState | null>(null)

export function OutletProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [outletId, setOutletIdState] = useState<string | null>(null)
  const [outlets, setOutlets] = useState<Outlet[]>([])

  const setOutletId = (id: string | null) => {
    authStore.outletId = id
    setOutletIdState(id)
  }

  const refreshOutlets = useCallback(() => {
    if (!isAdmin) return
    api
      .listOutlets()
      .then(setOutlets)
      .catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    // Admin: cross-outlet by default (no X-Outlet-Id). Non-admin: the token's
    // own outlet governs scope server-side, so leave the header unset.
    authStore.outletId = null
    setOutletIdState(null)
    if (!isAdmin) {
      setOutlets([])
      return
    }
    // Poll + refresh on focus so a newly created outlet shows in the switcher
    // without a hard refresh.
    refreshOutlets()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshOutlets()
    }, 15000)
    const onFocus = () => refreshOutlets()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [isAdmin, refreshOutlets])

  const value = useMemo<OutletState>(
    () => ({ outletId, setOutletId, outlets, isAdmin, refreshOutlets }),
    [outletId, outlets, isAdmin, refreshOutlets],
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
  return (
    <select
      value={outletId ?? ''}
      onChange={(e) => setOutletId(e.target.value || null)}
      className="px-3 py-1.5 bg-white border border-gray-200 rounded-xl text-xs font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-gold-500/40"
    >
      <option value="">Semua Outlet</option>
      {outlets.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}

/** Like useOutlet, but null outside an OutletProvider. For kit parts that must also render standalone (tests, server markup). */
export function useOptionalOutlet(): OutletState | null {
  return use(OutletCtx)
}
