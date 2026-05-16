/**
 * Wraps SyncEngine: exposes snapshot accessors, wall state, pending count,
 * online status, resync, and bootstraps engine on mount.
 */

import { useCallback, useContext, useEffect, useState } from 'react'
import type { WallState } from '@mandalika/sync'
import { SyncContext } from '../cashier/SyncProvider'

export interface OfflineDataState {
  isOnline: boolean
  wall: WallState
  pendingCount: number
  lastSyncedAt: string | null
  isResyncing: boolean
  resync: () => Promise<void>
  flush: () => void
}

export function useOfflineData(): OfflineDataState {
  const engine = useContext(SyncContext)
  if (!engine) throw new Error('useOfflineData must be used within SyncProvider')

  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [wall, setWall] = useState<WallState>(engine.getWall())
  const [pendingCount, setPendingCount] = useState(engine.pendingCount())
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => localStorage.getItem('mandalika.pos.lastSyncedAt'),
  )
  const [isResyncing, setIsResyncing] = useState(false)

  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

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
    }, 2000)
    return () => clearInterval(interval)
  }, [engine])

  return {
    isOnline,
    wall,
    pendingCount,
    lastSyncedAt,
    isResyncing,
    resync,
    flush,
  }
}
