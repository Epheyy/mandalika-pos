/**
 * Wraps SyncEngine: exposes snapshot accessors, wall state, pending count,
 * online status, resync, and bootstraps engine on mount.
 */

import { useCallback, use, useEffect, useState } from 'react'
import type { WallState } from '@mandalika/sync'
import { SyncContext } from '../cashier/SyncProvider'

export interface FailedItem {
  idempotencyKey: string
  type: string
  lastError?: string
}

export interface OfflineDataState {
  isOnline: boolean
  wall: WallState
  pendingCount: number
  failed: FailedItem[]
  lastSyncedAt: string | null
  isResyncing: boolean
  resync: () => Promise<void>
  flush: () => void
  retryFailed: () => void
  /** Detached diagnostic JSON. Leaves failed operations and retry state intact. */
  buildFailedSyncDiagnostics: () => string
}

export function useOfflineData(): OfflineDataState {
  const engine = use(SyncContext)
  if (!engine) throw new Error('useOfflineData must be used within SyncProvider')

  // Real server reachability from the engine (a GET actually succeeded),
  // NOT navigator.onLine — which falsely reports online on some Android
  // WebViews even with no connection.
  const [isOnline, setIsOnline] = useState(() => engine.isReachable())
  const [wall, setWall] = useState<WallState>(() => engine.getWall())
  const [pendingCount, setPendingCount] = useState(() => engine.pendingCount())
  const [failed, setFailed] = useState<FailedItem[]>(() => engine.deadLettered())
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => localStorage.getItem('mandalika.pos.lastSyncedAt'),
  )
  const [isResyncing, setIsResyncing] = useState(false)

  useEffect(() => {
    // Browser online/offline events are only hints here — on a connectivity
    // change, force an immediate reachability probe instead of trusting them.
    const probe = () => { void engine.checkVersion().then(() => setIsOnline(engine.isReachable())) }
    window.addEventListener('online', probe)
    window.addEventListener('offline', probe)
    // Probe once on mount so the dot is correct even if boot resync failed.
    probe()
    return () => {
      window.removeEventListener('online', probe)
      window.removeEventListener('offline', probe)
    }
  }, [engine])

  useEffect(() => {
    // Inject event listeners into the engine
    // The engine was created in SyncProvider with these callbacks
    const originalOnWall = engine['events']?.onWall
    const originalOnOutboxChange = engine['events']?.onOutboxChange

    // Monkey-patch is not ideal — instead we rely on SyncProvider passing events
    // These are initialized in SyncProvider; this hook only reads shared state
    void originalOnWall
    void originalOnOutboxChange
  }, [engine])

  const resync = useCallback(async () => {
    setIsResyncing(true)
    try {
      await engine.resync()
      const now = new Date().toISOString()
      setLastSyncedAt(now)
      localStorage.setItem('mandalika.pos.lastSyncedAt', now)
      setWall(engine.getWall())
    } finally {
      setIsResyncing(false)
    }
  }, [engine])

  const flush = useCallback(() => {
    void engine.flush()
  }, [engine])

  // Subscribe to engine events via polling (engine doesn't expose event emitter)
  useEffect(() => {
    const interval = setInterval(() => {
      setWall(engine.getWall())
      setPendingCount(engine.pendingCount())
      setFailed(engine.deadLettered())
      setIsOnline(engine.isReachable())
    }, 2000)
    return () => clearInterval(interval)
  }, [engine])

  const retryFailed = useCallback(() => {
    engine.retryFailed()
    setFailed(engine.deadLettered())
    setPendingCount(engine.pendingCount())
  }, [engine])

  const buildFailedSyncDiagnostics = useCallback(
    () => engine.buildFailedSyncDiagnostics(),
    [engine],
  )

  return {
    isOnline,
    wall,
    pendingCount,
    failed,
    lastSyncedAt,
    isResyncing,
    resync,
    flush,
    retryFailed,
    buildFailedSyncDiagnostics,
  }
}
