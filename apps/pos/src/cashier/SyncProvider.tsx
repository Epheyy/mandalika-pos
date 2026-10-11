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
import { SyncEngine, RECEIVE_CONFLICT_CODES, getKV } from '@mandalika/sync'
import type { WallState } from '@mandalika/sync'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { currentActor } from '../actor'
import { hideSplash } from '../native'
import { reportErrors } from '../lib/errorReporter'
import { AppLoadingSkeleton } from '../components/Skeleton'
import { OUTBOX_CORRUPT_MESSAGE, OUTBOX_CORRUPT_UNSECURED_MESSAGE, OUTBOX_CORRUPT_PENDING_MESSAGE } from '../lib/durableSubmit'

type Transfer = components['schemas']['Transfer']

// eslint-disable-next-line react-refresh/only-export-components
export const SyncContext = createContext<SyncEngine | null>(null)

// Exposes the onReceiveRejected ref so CashierScreen can register a toast
// callback without the prop needing to be threaded through App.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export const SyncReceiveRejectedRefContext = createContext<MutableRefObject<((msg: string) => void) | undefined> | null>(null)

// Exposes the onReceiveAccepted ref so CashierScreen can trigger the
// TandaTerimaPrompt without prop-drilling through App.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export const SyncReceiveAcceptedRefContext = createContext<MutableRefObject<((transfer: Transfer) => void) | undefined> | null>(null)

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
  const onReceiveAcceptedRef = useRef<((transfer: Transfer) => void) | undefined>(undefined)

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
            // Competing/missing-transfer receipts already raised onReceiveRejected with the
            // precise message; any other receive that needs review gets this one.
            const hadOtherReceiveReview = items.some(
              (i) => i.type === 'transfer_receive' && !(i.reviewCode && RECEIVE_CONFLICT_CODES.includes(i.reviewCode)),
            )
            if (hadOtherReceiveReview) {
              onReceiveRejectedRef.current?.('Penerimaan perlu ditinjau — transfer mungkin sudah diterima atau PIN ditolak. Stok dikembalikan; hitungan tetap tersimpan.')
            }
          },
          onStuckRetrying: (items) => {
            void reportErrors(
              items.map((i) => ({
                source: 'sync' as const,
                kind: i.type,
                action: `Sinkronisasi tertunda berulang: ${i.type}`,
                message: i.lastError ?? 'server bermasalah',
                payload: i.payload,
                outletName: engineRef.current?.getSnapshot().outletName ?? null,
              })),
            )
          },
          onReceiveRejected: (msg) => onReceiveRejectedRef.current?.(msg),
          onReceiveAccepted: (transfer) => onReceiveAcceptedRef.current?.(transfer),
        },
        getKV(),
        // Every queued item is stamped with who/where it was captured (A04).
        { actor: currentActor },
      )
      engineRef.current = e
      return e
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // The stored queue was unreadable: its raw bytes were quarantined and the
  // queue started empty. Say so on every screen, and ship it to the error log.
  const corruption = engine.outboxCorruption()
  const [quarantineOk, setQuarantineOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (!corruption) return
    let live = true
    void engine.outbox.quarantineResult().then((ok) => { if (live) setQuarantineOk(ok) })
    void reportErrors([{
      source: 'runtime',
      kind: 'outbox_corrupt',
      action: 'Antrean sinkronisasi rusak',
      message: `Outbox tidak terbaca; salinan asli disimpan di ${corruption.quarantineKey}`,
    }])
    return () => { live = false }
  }, [corruption, engine])

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
    return () => {
      stop()
      // Logout/unmount: this engine must never write the outbox again (the next
      // login builds a new one). start() revives it for StrictMode's dev re-run.
      engine.dispose()
    }
  }, [engine])

  if (!ready) {
    return <AppLoadingSkeleton />
  }

  return (
    <SyncContext.Provider value={engine}>
      {corruption && (
        // Persistent and non-dismissable; pointer-events-none so it never blocks the header.
        <div role="alert" className="pointer-events-none fixed inset-x-0 top-0 z-[100] bg-red-700 text-white text-sm font-bold px-4 py-2 text-center safe-top">
          {quarantineOk === null
            ? OUTBOX_CORRUPT_PENDING_MESSAGE
            : quarantineOk ? OUTBOX_CORRUPT_MESSAGE : OUTBOX_CORRUPT_UNSECURED_MESSAGE}
        </div>
      )}
      <SyncReceiveRejectedRefContext.Provider value={onReceiveRejectedRef}>
        <SyncReceiveAcceptedRefContext.Provider value={onReceiveAcceptedRef}>
          {children}
        </SyncReceiveAcceptedRefContext.Provider>
      </SyncReceiveRejectedRefContext.Provider>
    </SyncContext.Provider>
  )
}
