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
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { SyncEngine, getKV } from '@mandalika/sync'
import type { WallState } from '@mandalika/sync'
import { api } from '../api'
import { hideSplash } from '../native'
import { reportErrors } from '../lib/errorReporter'
import { AppLoadingSkeleton } from '../components/Skeleton'

// eslint-disable-next-line react-refresh/only-export-components
export const SyncContext = createContext<SyncEngine | null>(null)

// Exposes the onReceiveRejected ref so CashierScreen can register a toast
// callback without the prop needing to be threaded through App.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export const SyncReceiveRejectedRefContext = createContext<MutableRefObject<((msg: string) => void) | undefined> | null>(null)

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
  const onReceiveRejectedRef = useRef<((msg: string) => void) | undefined>(undefined)

  const [ready, setReady] = useState(false)
  const engineRef = useRef<SyncEngine | null>(null)

  const engine = useMemo(
    () => {
      const e = new SyncEngine(
        api,
        {
          onWall: (w) => onWallRef.current?.(w),
          onOutboxChange: (n) => onPendingRef.current?.(n),
          // TEMP (polish phase): force on so the CI release APK surfaces
          // [sync] diagnostics on-device. Set to `import.meta.env.DEV`
          // before true-final (dev-only, silent in release).
          debug: true,
          // Permanently-failed sync ops → server error log (Backoffice).
          onDeadLetter: (items) => {
            void reportErrors(
              items.map((i) => ({
                source: 'sync' as const,
                kind: i.type,
                action: `Sinkronisasi gagal: ${i.type}`,
                message: i.lastError ?? 'sync gagal',
                payload: i.payload,
                outletName: engineRef.current?.getSnapshot().outletName ?? null,
              })),
            )
            const hadReceiveReject = items.some((i) => i.type === 'transfer_receive')
            if (hadReceiveReject) {
              onReceiveRejectedRef.current?.('Penerimaan dibatalkan — transfer mungkin sudah diterima atau PIN ditolak. Stok dikembalikan.')
            }
          },
          onReceiveRejected: (msg) => onReceiveRejectedRef.current?.(msg),
        },
        getKV(),
      )
      engineRef.current = e
      return e
    },
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
      .finally(() => {
        setReady(true)
        void hideSplash()
      })

    // Poll every 12s: flushes the outbox and refreshes real server
    // reachability (drives the header online/offline dot).
    const stop = engine.start(12_000)
    return stop
  }, [engine])

  if (!ready) {
    return <AppLoadingSkeleton />
  }

  return (
    <SyncContext.Provider value={engine}>
      <SyncReceiveRejectedRefContext.Provider value={onReceiveRejectedRef}>
        {children}
      </SyncReceiveRejectedRefContext.Provider>
    </SyncContext.Provider>
  )
}
