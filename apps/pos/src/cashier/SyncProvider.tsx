/**
 * Creates one SyncEngine instance for the lifetime of the authenticated session,
 * bootstraps resync + polling on mount, and provides the engine via context.
 */

import {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SyncEngine } from '@mandalika/sync'
import type { WallState } from '@mandalika/sync'
import { api } from '../api'

// eslint-disable-next-line react-refresh/only-export-components
export const SyncContext = createContext<SyncEngine | null>(null)

interface SyncProviderProps {
  children: ReactNode
  onWall?: (w: WallState) => void
  onPendingChange?: (count: number) => void
}

export function SyncProvider({
  children,
  onWall,
  onPendingChange,
}: SyncProviderProps) {
  const onWallRef = useRef(onWall)
  onWallRef.current = onWall
  const onPendingRef = useRef(onPendingChange)
  onPendingRef.current = onPendingChange

  const [ready, setReady] = useState(false)

  const engine = useMemo(
    () =>
      new SyncEngine(api, {
        onWall: (w) => onWallRef.current?.(w),
        onOutboxChange: (n) => onPendingRef.current?.(n),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    // Bootstrap: pull snapshot, then start periodic polling
    engine
      .resync()
      .catch(() => {
        // Offline on first load — engine keeps selling from empty snapshot
      })
      .finally(() => setReady(true))

    const stop = engine.start(20_000)
    return stop
  }, [engine])

  if (!ready) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'system-ui',
          color: '#6b7280',
        }}
      >
        Memuat data…
      </div>
    )
  }

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>
}
