/**
 * Manages current shift: fetches via API, open/close via engine.enqueue.
 */

import { useCallback, use, useEffect, useRef, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { SyncContext } from '../cashier/SyncProvider'
import { createSubmitGate, notSavedMessage } from '../lib/durableSubmit'

type Shift = components['schemas']['Shift']

export interface ShiftState {
  currentShift: Shift | null
  isLoadingShift: boolean
  isOpeningShift: boolean
  isClosingShift: boolean
  /** Resolve true once the shift op is durably queued; false if not saved or already in flight. */
  openShift: (startingCash: number, outletName?: string) => Promise<boolean>
  closeShift: (closingCash: number, countedByMethod?: Record<string, number>) => Promise<boolean>
  /** Persistent error when a shift op could not be stored on the device. */
  shiftError: string | null
  clearShiftError: () => void
  refreshShift: () => Promise<void>
}

export function useShift(): ShiftState {
  const engine = use(SyncContext)
  if (!engine) throw new Error('useShift must be used within SyncProvider')

  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [isLoadingShift, setIsLoadingShift] = useState(true)
  const [isOpeningShift, setIsOpeningShift] = useState(false)
  const [isClosingShift, setIsClosingShift] = useState(false)
  const [shiftError, setShiftError] = useState<string | null>(null)
  // One gate for open + close: a ref flips synchronously, unlike the state flags.
  const gate = useRef(createSubmitGate())
  const clearShiftError = useCallback(() => setShiftError(null), [])

  const refreshShift = useCallback(async () => {
    setIsLoadingShift(true)
    try {
      const r = await api.request<{ data: Shift | null }>(
        'GET',
        '/api/v1/shifts/current',
      )
      setCurrentShift(r.data)
    } catch {
      // offline — keep last known shift
    } finally {
      setIsLoadingShift(false)
    }
  }, [])

  useEffect(() => {
    void refreshShift()
  }, [refreshShift])

  const openShift = useCallback(
    async (startingCash: number, outletName?: string): Promise<boolean> => {
      if (gate.current.isBusy()) return false
      setIsOpeningShift(true)
      setShiftError(null)
      const outcome = await gate.current.run(() => engine.enqueue('shift_open', { startingCash, outletName }))
      if (outcome.status !== 'saved') {
        if (outcome.status === 'failed') {
          setIsOpeningShift(false)
          setShiftError(notSavedMessage('Buka shift'))
        }
        return false
      }
      // Refresh after a short delay to pick up the newly opened shift
      setTimeout(() => {
        void refreshShift().finally(() => setIsOpeningShift(false))
      }, 1500)
      return true
    },
    [engine, refreshShift],
  )

  // Auto-open a zero-cash shift on first load when the outlet enables it
  // (app_settings.autoOpenShift), so cashiers don't get blocked at start.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (isLoadingShift || currentShift || isOpeningShift) return
    if (autoOpenedRef.current) return
    if (engine.getSnapshot().appSettings?.autoOpenShift) {
      autoOpenedRef.current = true
      void openShift(0)
    }
  }, [isLoadingShift, currentShift, isOpeningShift, engine, openShift])

  const closeShift = useCallback(
    async (closingCash: number, countedByMethod?: Record<string, number>): Promise<boolean> => {
      if (!currentShift?.id || gate.current.isBusy()) return false
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
        if (outcome.status === 'failed') {
          setIsClosingShift(false)
          setShiftError(notSavedMessage('Tutup shift'))
        }
        return false
      }
      setTimeout(() => {
        void refreshShift().finally(() => setIsClosingShift(false))
      }, 1500)
      return true
    },
    [engine, currentShift, refreshShift],
  )

  return {
    currentShift,
    isLoadingShift,
    isOpeningShift,
    isClosingShift,
    openShift,
    closeShift,
    shiftError,
    clearShiftError,
    refreshShift,
  }
}
