/**
 * Wraps SyncEngine: exposes snapshot accessors, wall state, pending count,
 * online status, resync, and bootstraps engine on mount.
 */

import { isResyncingNow, nextLastSyncedAt } from './autoPullStatus'
import { useCallback, use, useEffect, useState } from 'react'
import type { SyncEngine, WallState } from '@mandalika/sync'
import { SyncContext } from '../cashier/SyncProvider'
import { authStore } from '../api'
import { ownerLabel } from '../terminalBinding'
import { refundDetail } from '../cashier/refundView'
import { STUCK_RETRY_MESSAGE, stuckMessage } from '../lib/stuckMessage'

export interface FailedItem {
  idempotencyKey: string
  type: string
  lastError?: string
  clientCreatedAt?: string
  /** Server code or client reason (e.g. competing_receipt, batch_rejected); unset for legacy parks. */
  reviewCode?: string
  /** Set when the item was captured by ANOTHER account (its envelope userId): shown as "milik akun X". */
  ownedBy?: string
  /** What the cashier captured, e.g. a refund as "BSD-G0007 · Rp 225.000 · Tunai". Unset for items without a snapshot. */
  detail?: string
  /** Sent to head office in a successful review check-in. */
  reported?: boolean
}

export interface OfflineDataState {
  isOnline: boolean
  wall: WallState
  pendingCount: number
  /** Parked items needing a person's review (never auto-retried, never deleted). */
  review: FailedItem[]
  /** Items still retrying that keep failing on the server (slice 4). */
  stuck: FailedItem[]
  /** Set while the server refuses every batch for an account/session reason (403 etc.). */
  accountProblem: string | null
  lastSyncedAt: string | null
  isResyncing: boolean
  resync: () => Promise<void>
  flush: () => void
  /** Re-queue parked items. Rejects if the reset could not be stored (items stay parked). */
  retryFailed: () => Promise<void>
  /** Detached diagnostic JSON. Leaves failed operations and retry state intact. */
  buildFailedSyncDiagnostics: () => string
}

export { STUCK_RETRY_MESSAGE }

/** Parked items (needs review) and, separately, still-retrying items that keep failing. */
function attention(engine: SyncEngine): { review: FailedItem[]; stuck: FailedItem[] } {
  const review: FailedItem[] = engine.reviewItems().map((r) => ({
    idempotencyKey: r.idempotencyKey,
    type: r.type,
    clientCreatedAt: r.clientCreatedAt,
    reviewCode: r.reviewCode,
    lastError: r.reviewReason ?? r.lastError,
    detail: r.type === 'refund' ? refundDetail(r.payload) : undefined,
    reported: engine.isReviewReported(r.idempotencyKey),
    ownedBy:
      r.ownerUserId && r.ownerUserId !== authStore.userId
        ? ownerLabel(r.ownerUserId, engine.getSnapshot().users)
        : undefined,
  }))
  const reviewKeys = new Set(review.map((d) => d.idempotencyKey))
  const stuck = engine
    .stuckRetrying()
    .filter((s) => !reviewKeys.has(s.idempotencyKey))
    .map((s) => ({ ...s, lastError: stuckMessage(s) }))
  return { review, stuck }
}

export function sameItems(a: FailedItem[], b: FailedItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.idempotencyKey === b[i].idempotencyKey && x.lastError === b[i].lastError && x.ownedBy === b[i].ownedBy && x.detail === b[i].detail && x.reported === b[i].reported)
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
  const [accountProblem, setAccountProblem] = useState<string | null>(() => engine.accountProblem())
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(
    () => localStorage.getItem('mandalika.pos.lastSyncedAt'),
  )
  const [manualResyncing, setManualResyncing] = useState(false)
  const [enginePulling, setEnginePulling] = useState(() => engine.isPulling())

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
    setManualResyncing(true)
    try {
      await engine.resync()
      const now = new Date().toISOString()
      setLastSyncedAt(now)
      localStorage.setItem('mandalika.pos.lastSyncedAt', now)
      setWall(engine.getWall())
    } finally {
      setManualResyncing(false)
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
      setAccountProblem(engine.accountProblem())
      setIsOnline(engine.isReachable())
      // Background pulls: show them as syncing and keep "last synced" honest.
      setEnginePulling(engine.isPulling())
      setLastSyncedAt((prev) => {
        const next = nextLastSyncedAt(prev, engine.lastPulledAt())
        if (next === null) return prev
        localStorage.setItem('mandalika.pos.lastSyncedAt', next)
        return next
      })
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
    accountProblem,
    lastSyncedAt,
    isResyncing: isResyncingNow(manualResyncing, enginePulling),
    resync,
    flush,
    retryFailed,
    buildFailedSyncDiagnostics,
  }
}
