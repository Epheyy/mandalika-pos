/**
 * Manages current shift: fetches via API, open/close via engine.enqueue.
 */

import { useCallback, useContext, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { SyncContext } from '../cashier/SyncProvider'

type Shift = components['schemas']['Shift']

export interface ShiftState {
  currentShift: Shift | null
  isLoadingShift: boolean
  isOpeningShift: boolean
  isClosingShift: boolean
  openShift: (startingCash: number, outletName?: string) => void
  closeShift: (closingCash: number) => void
  refreshShift: () => Promise<void>
}

export function useShift(): ShiftState {
  const engine = useContext(SyncContext)
  if (!engine) throw new Error('useShift must be used within SyncProvider')

  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [isLoadingShift, setIsLoadingShift] = useState(true)
  const [isOpeningShift, setIsOpeningShift] = useState(false)
  const [isClosingShift, setIsClosingShift] = useState(false)

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
    (startingCash: number, outletName?: string) => {
      setIsOpeningShift(true)
      engine.enqueue('shift_open', { startingCash, outletName })
      // Refresh after a short delay to pick up the newly opened shift
      setTimeout(() => {
        void refreshShift().finally(() => setIsOpeningShift(false))
      }, 1500)
    },
    [engine, refreshShift],
  )

  const closeShift = useCallback(
    (closingCash: number) => {
      if (!currentShift?.id) return
      setIsClosingShift(true)
      engine.enqueue('shift_close', {
        shiftId: currentShift.id,
        closingCash,
      })
      setTimeout(() => {
        void refreshShift().finally(() => setIsClosingShift(false))
      }, 1500)
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
    refreshShift,
  }
}
