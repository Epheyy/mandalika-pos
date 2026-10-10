/**
 * Wraps SyncEngine: exposes snapshot accessors, wall state, pending count,
 * online status, resync, and bootstraps engine on mount.
 */

import { useCallback, use, useEffect, useState } from 'react'
import type { SyncEngine, WallState } from '@mandalika/sync'
import { SyncContext } from '../cashier/SyncProvider'

export interface FailedItem {
  idempotencyKey: string
  type: string
  lastError?: string
  clientCreatedAt?: string
  /** Server code or client reason (e.g. competing_receipt, batch_rejected); unset for legacy parks. */
  reviewCode?: string
}

export interface OfflineDataState {
  isOnline: boolean
  wall: WallState
  pendingCount: number
  /** Parked items needing a person's review (never auto-retried, never deleted). */
  review: FailedItem[]
  /** Items still retrying that keep failing on the server (slice 4). */
  stuck: FailedItem[]
  lastSyncedAt: string | null
  isResyncing: boolean
  resync: () => Promise<void>
  flush: () => void
  /** Re-queue parked items. Rejects if the reset could not be stored (items stay parked). */
  retryFailed: () => Promise<void>
  /** Detached diagnostic JSON. Leaves failed operations and retry state intact. */
  buildFailedSyncDiagnostics: () => string
}

export const STUCK_RETRY_MESSAGE =
  'Belum tersinkron setelah beberapa kali coba — server sedang bermasalah. Tetap dicoba ulang otomatis; hubungi admin bila berlanjut.'

/** Parked items (needs review) and, separately, still-retrying items that keep failing. */
function attention(engine: SyncEngine): { review: FailedItem[]; stuck: FailedItem[] } {
  const review: FailedItem[] = engine.reviewItems().map((r) => ({
    idempotencyKey: r.idempotencyKey,
    type: r.type,
    clientCreatedAt: r.clientCreatedAt,
    reviewCode: r.reviewCode,
    lastError: r.reviewReason ?? r.lastError,
  }))
  const reviewKeys = new Set(review.map((d) => d.idempotencyKey))
  const stuck = engine
    .stuckRetrying()
    .filter((s) => !reviewKeys.has(s.idempotencyKey))
    .map((s) => ({ ...s, lastError: STUCK_RETRY_MESSAGE }))
  return { review, stuck }
}

function sameItems(a: FailedItem[], b: FailedItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.idempotencyKey === b[i].idempotencyKey && x.lastError === b[i].lastError)
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
  const [attn, setAttn] = useState(() => attention(engine))
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
    void engine.flushNow() // user-initiated: ignore any transient-failure backoff
  }, [engine])

  // Subscribe to engine events via polling (engine doesn't expose event emitter)
  useEffect(() => {
    const interval = setInterval(() => {
      setWall(engine.getWall())
      setPendingCount(engine.pendingCount())
      setAttn((prev) => {
        const next = attention(engine)
        return sameItems(prev.review, next.review) && sameItems(prev.stuck, next.stuck) ? prev : next
      })
      setIsOnline(engine.isReachable())
    }, 2000)
    return () => clearInterval(interval)
  }, [engine])

  const retryFailed = useCallback(async () => {
    await engine.retryFailed()
    setAttn(attention(engine))
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
    review: attn.review,
    stuck: attn.stuck,
    lastSyncedAt,
    isResyncing,
    resync,
    flush,
    retryFailed,
    buildFailedSyncDiagnostics,
  }
}
