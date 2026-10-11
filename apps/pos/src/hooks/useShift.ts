/**
 * Manages the current shift: fetches via API, open/close via engine.enqueue.
 *
 * A04: the header must be trustworthy offline. The last shift the server reported is
 * persisted per outlet and shown after a restart; pending (unacknowledged) shift opens
 * and closes are overlaid on it; it is re-fetched on mount, when the server becomes
 * reachable again and when a shift operation is acknowledged; and auto-open only fires
 * after a fetch succeeded in this session. Opening a shift needs the server (online).
 */

import { useCallback, use, useEffect, useMemo, useRef, useState } from 'react'
import type { components } from '@mandalika/api'
import { getKV } from '@mandalika/sync'
import { api, authStore } from '../api'
import { useAuth } from '../auth'
import { SyncContext } from '../cashier/SyncProvider'
import { createSubmitGate, notSavedMessage } from '../lib/durableSubmit'
import {
  OFFLINE_OPEN_MESSAGE,
  PENDING_CLOSE_MESSAGE,
  canOpenShift,
  isPendingOpen,
  overlayShift,
  planOpsUpdate,
  readShiftCache,
  shouldAutoOpen,
  writeShiftCache,
} from './shiftView'

type Shift = components['schemas']['Shift']

export interface ShiftState {
  currentShift: Shift | null
  isLoadingShift: boolean
  isOpeningShift: boolean
  isClosingShift: boolean
  /** Server reachable AND GET /shifts/current has succeeded this session. "Buka Shift" needs both. */
  canOpenShift: boolean
  /** Resolve true once the shift op is durably queued; false if not saved, offline or already in flight. */
  openShift: (startingCash: number, outletName?: string) => Promise<boolean>
  closeShift: (closingCash: number, countedByMethod?: Record<string, number>) => Promise<boolean>
  /** Persistent error when a shift op could not be stored on the device. */
  shiftError: string | null
  clearShiftError: () => void
  /** Resolves true when the server answered (the shown shift is then authoritative). */
  refreshShift: () => Promise<boolean>
}

const POLL_MS = 2000

export function useShift(): ShiftState {
  const engine = use(SyncContext)
  if (!engine) throw new Error('useShift must be used within SyncProvider')
  const { user } = useAuth()
  const outletId = authStore.outletId

  // Last shift the server reported for this outlet (survives restarts); null = none known.
  const [serverShift, setServerShift] = useState<Shift | null>(() => readShiftCache(getKV(), outletId))
  const [fetchedThisSession, setFetchedThisSession] = useState(false)
  // Show "Memuat shift…" only while the first attempt runs and nothing is known yet.
  const [isLoadingShift, setIsLoadingShift] = useState(() => readShiftCache(getKV(), outletId) === null)
  const [isOpeningShift, setIsOpeningShift] = useState(false)
  const [isClosingShift, setIsClosingShift] = useState(false)
  const [shiftError, setShiftError] = useState<string | null>(null)
  const [ops, setOps] = useState(() => engine.pendingShiftOps())
  const [online, setOnline] = useState(() => engine.isReachable())
  // One gate for open + close: a ref flips synchronously, unlike the state flags.
  const gate = useRef(createSubmitGate())
  const clearShiftError = useCallback(() => setShiftError(null), [])

  const refreshShift = useCallback(async (): Promise<boolean> => {
    try {
      const r = await api.request<{ data: Shift | null }>('GET', '/api/v1/shifts/current')
      setServerShift(r.data)
      writeShiftCache(getKV(), outletId, r.data)
      setFetchedThisSession(true)
      return true
    } catch {
      // offline or a server hiccup: keep the last known shift, never conclude "no shift"
      return false
    } finally {
      setIsLoadingShift(false)
    }
  }, [outletId])

  // On mount.
  useEffect(() => {
    void refreshShift()
  }, [refreshShift])

  // The displayed pending operations (overlay). Moved to the engine's only per planOpsUpdate:
  // acknowledged or parked operations are dropped from the overlay AFTER a successful refetch.
  const shownOps = useRef(ops)
  const applyOps = useCallback((next: typeof ops) => {
    shownOps.current = next
    setOps(next)
  }, [])
  const fetching = useRef(false)
  const lastOnline = useRef(engine.isReachable())
  useEffect(() => {
    const t = setInterval(() => {
      const nextOps = engine.pendingShiftOps()
      const nextOnline = engine.isReachable()
      if (nextOnline !== lastOnline.current) setOnline(nextOnline)
      const cameBack = nextOnline && !lastOnline.current
      lastOnline.current = nextOnline
      const plan = planOpsUpdate(shownOps.current, nextOps)
      if (plan === 'apply') applyOps(nextOps)
      const wantFetch = cameBack || plan === 'fetch-then-apply'
      if (!wantFetch || !nextOnline || fetching.current) return
      fetching.current = true
      void refreshShift()
        .then((ok) => { if (ok && plan === 'fetch-then-apply') applyOps(nextOps) }) // else retried next tick
        .finally(() => { fetching.current = false })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [engine, refreshShift, applyOps])

  const currentShift = useMemo(
    () =>
      overlayShift(serverShift, ops, {
        outletId: outletId ?? '',
        cashierId: user?.id ?? '',
        cashierName: user?.displayName ?? '',
      }),
    [serverShift, ops, outletId, user],
  )

  // Captured items carry the shift id when it is known (a pending open has none yet).
  useEffect(() => {
    authStore.shiftId = currentShift && !isPendingOpen(currentShift) ? currentShift.id : null
    return () => { authStore.shiftId = null }
  }, [currentShift])

  const openShift = useCallback(
    async (startingCash: number, outletName?: string): Promise<boolean> => {
      if (gate.current.isBusy()) return false
      if (!engine.isReachable() || !fetchedThisSession) {
        // Without a fresh answer from the server we cannot know whether a shift is already
        // open, and two opens at one outlet are what this prevents. Selling offline works
        // once a shift is open.
        setShiftError(OFFLINE_OPEN_MESSAGE)
        return false
      }
      setIsOpeningShift(true)
      setShiftError(null)
      const outcome = await gate.current.run(() => engine.enqueue('shift_open', { startingCash, outletName }))
      if (outcome.status !== 'saved') {
        setIsOpeningShift(false)
        if (outcome.status === 'failed') setShiftError(notSavedMessage('Buka shift'))
        return false
      }
      applyOps(engine.pendingShiftOps()) // show it at once, before the next poll
      // Refresh after a short delay to pick up the newly opened shift
      setTimeout(() => {
        void refreshShift().finally(() => setIsOpeningShift(false))
      }, 1500)
      return true
    },
    [engine, refreshShift, fetchedThisSession, applyOps],
  )

  // Auto-open a zero-cash shift when the outlet enables it (app_settings.autoOpenShift),
  // but only on facts: a fetch succeeded this session and nothing is showing.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (
      !shouldAutoOpen({
        enabled: !!engine.getSnapshot().appSettings?.autoOpenShift,
        fetchedThisSession,
        hasShift: currentShift !== null,
        isOpening: isOpeningShift,
        alreadyTried: autoOpenedRef.current,
        online,
      })
    ) return
    autoOpenedRef.current = true
    void openShift(0)
  }, [fetchedThisSession, currentShift, isOpeningShift, online, engine, openShift])

  const closeShift = useCallback(
    async (closingCash: number, countedByMethod?: Record<string, number>): Promise<boolean> => {
      if (!currentShift || gate.current.isBusy()) return false
      if (isPendingOpen(currentShift)) {
        // Opened offline-pending: the server has no id to close yet.
        setShiftError(PENDING_CLOSE_MESSAGE)
        return false
      }
      setIsClosingShift(true)
      setShiftError(null)
      const outcome = await gate.current.run(() => engine.enqueue('shift_close', {
        shiftId: currentShift.id,
        closingCash,
        // Per-method counted cash (reconciliation). Optional — the quick close
        // from the header omits it; the Rekapan close sends it. Offline-safe:
        // it rides the same shift_close outbox op.
        ...(countedByMethod ? { countedByMethod } : {}),
      }))
      if (outcome.status !== 'saved') {
        setIsClosingShift(false)
        if (outcome.status === 'failed') setShiftError(notSavedMessage('Tutup shift'))
        return false
      }
      applyOps(engine.pendingShiftOps())
      setTimeout(() => {
        void refreshShift().finally(() => setIsClosingShift(false))
      }, 1500)
      return true
    },
    [engine, currentShift, refreshShift, applyOps],
  )

  return {
    currentShift,
    isLoadingShift,
    isOpeningShift,
    isClosingShift,
    canOpenShift: canOpenShift(online, fetchedThisSession),
    openShift,
    closeShift,
    shiftError,
    clearShiftError,
    refreshShift,
  }
}
