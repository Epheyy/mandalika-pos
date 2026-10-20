// Auto-pull gate (plan 2.6): the engine pulls reference data in the background only when this says the
// cashier has nothing in flight. A cart line carries the price captured when it was added and a receipt
// stamps the reference version at sale time, so a mid-cart swap would mix versions.
import { useEffect, useRef } from 'react'
import type { SyncEngine } from '@mandalika/sync'

export interface AutoPullFlags {
  cartCount: number
  isCheckoutOpen: boolean
  isProcessing: boolean
  isSuccessOpen: boolean
  hasRefundOrder: boolean
  hasRefundSale: boolean
  isRefunding: boolean
  showReceive: boolean
  hasPendingReceive: boolean
  /** The TandaTerima prompt after a receive. */
  hasPendingTT: boolean
  hasPendingFulfillment: boolean
  isAddingCustomer: boolean
  isSavingCustomer: boolean
  hasActiveAdjustment: boolean
  showHistory: boolean
  showLocalReceipts: boolean
  showRecap: boolean
  showTransferHistory: boolean
  showSettings: boolean
  showMenu: boolean
  shiftPrompt: boolean
  closeIntent: boolean
}

export const AUTO_PULL_IDLE: AutoPullFlags = {
  cartCount: 0,
  isCheckoutOpen: false,
  isProcessing: false,
  isSuccessOpen: false,
  hasRefundOrder: false,
  hasRefundSale: false,
  isRefunding: false,
  showReceive: false,
  hasPendingReceive: false,
  hasPendingTT: false,
  hasPendingFulfillment: false,
  isAddingCustomer: false,
  isSavingCustomer: false,
  hasActiveAdjustment: false,
  showHistory: false,
  showLocalReceipts: false,
  showRecap: false,
  showTransferHistory: false,
  showSettings: false,
  showMenu: false,
  shiftPrompt: false,
  closeIntent: false,
}

export function isSafeToAutoPull(f: AutoPullFlags): boolean {
  return Object.values(f).every((v) => !v)
}

type GateTarget = Pick<SyncEngine, 'setAutoPullGate'>
type NudgeTarget = Pick<SyncEngine, 'nudgeAutoPull'>

/** Register the gate (reading the latest flags at call time); the returned disposer unregisters it. */
export function bindAutoPullGate(engine: GateTarget, getFlags: () => AutoPullFlags): () => void {
  engine.setAutoPullGate(() => isSafeToAutoPull(getFlags()))
  return () => engine.setAutoPullGate(null)
}

/** Returns an updater to call with the current safe state; nudges the engine on every busy to idle edge. */
export function createIdleNudger(engine: NudgeTarget): (safe: boolean) => void {
  let prev = true
  return (safe) => {
    if (safe && !prev) engine.nudgeAutoPull()
    prev = safe
  }
}

export function useAutoPullGate(engine: SyncEngine, flags: AutoPullFlags): void {
  const flagsRef = useRef(flags)
  useEffect(() => { flagsRef.current = flags }) // after every commit: the gate reads the screen as rendered
  useEffect(() => bindAutoPullGate(engine, () => flagsRef.current), [engine])
  const nudgerRef = useRef<((safe: boolean) => void) | null>(null)
  useEffect(() => { nudgerRef.current = createIdleNudger(engine) }, [engine])
  const safe = isSafeToAutoPull(flags)
  useEffect(() => { nudgerRef.current?.(safe) }, [safe])
}
