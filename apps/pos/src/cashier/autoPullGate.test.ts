import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AUTO_PULL_IDLE, bindAutoPullGate, createIdleNudger, isSafeToAutoPull, type AutoPullFlags } from './autoPullGate'

// The cashier's "safe to swap reference data" gate. Anything that holds a captured price or an
// in-progress flow must block a background pull (plan 2.6).

describe('isSafeToAutoPull', () => {
  it('is safe when nothing is in progress', () => {
    expect(isSafeToAutoPull(AUTO_PULL_IDLE)).toBe(true)
  })

  it.each(Object.keys(AUTO_PULL_IDLE) as (keyof AutoPullFlags)[])('%s blocks the pull', (key) => {
    const busy = { ...AUTO_PULL_IDLE, [key]: typeof AUTO_PULL_IDLE[key] === 'number' ? 1 : true }
    expect(isSafeToAutoPull(busy)).toBe(false)
  })

  it('covers every flag the plan lists', () => {
    for (const k of ['cartCount', 'isCheckoutOpen', 'isProcessing', 'isSuccessOpen', 'hasRefundOrder', 'hasRefundSale',
      'isRefunding', 'showReceive', 'hasPendingReceive', 'hasPendingTT', 'hasPendingFulfillment', 'isAddingCustomer',
      'hasActiveAdjustment', 'hasSelectedCustomer', 'hasSelectedSalesman', 'appliedPromotionCount', 'appliedPromoCodeCount',
      'pointsToRedeem']) expect(Object.keys(AUTO_PULL_IDLE)).toContain(k)
  })
})

function fakeEngine() {
  return { setAutoPullGate: vi.fn(), nudgeAutoPull: vi.fn() }
}

describe('bindAutoPullGate', () => {
  it('registers a gate that reads the latest flags, and unregisters with null', () => {
    const e = fakeEngine()
    let flags: AutoPullFlags = AUTO_PULL_IDLE
    const dispose = bindAutoPullGate(e, () => flags)
    const gate = e.setAutoPullGate.mock.calls[0][0] as () => boolean
    expect(gate()).toBe(true)
    flags = { ...AUTO_PULL_IDLE, cartCount: 2 }
    expect(gate()).toBe(false)
    dispose()
    expect(e.setAutoPullGate).toHaveBeenLastCalledWith(null)
  })
})

describe('createIdleNudger', () => {
  it('nudges only on a busy to idle edge', () => {
    const e = fakeEngine()
    const n = createIdleNudger(e)
    n(false); n(false)
    expect(e.nudgeAutoPull).not.toHaveBeenCalled()
    n(true)
    expect(e.nudgeAutoPull).toHaveBeenCalledTimes(1)
    n(true)
    expect(e.nudgeAutoPull).toHaveBeenCalledTimes(1)
    n(false); n(true)
    expect(e.nudgeAutoPull).toHaveBeenCalledTimes(2)
  })
})

describe('useAutoPullGate hook source', () => {
  // The POS test setup has no DOM, so effects cannot run here: pin the wiring in the source instead.
  const src = readFileSync(new URL('./autoPullGate.ts', import.meta.url), 'utf8')
  it('refreshes the flags ref in a layout effect (before any async result can be read) and binds with null cleanup', () => {
    expect(src).toContain('useLayoutEffect(() => { flagsRef.current = flags })')
    expect(src).toContain('bindAutoPullGate(engine, () => flagsRef.current)')
    expect(src).toContain('engine.setAutoPullGate(null)')
  })
})

describe('CashierScreen wiring', () => {
  const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
  it('feeds the hook with the screen state and every overlay flag', () => {
    expect(src).toContain('useAutoPullGate(engine,')
    const call = src.slice(src.indexOf('useAutoPullGate(engine,'), src.indexOf('})', src.indexOf('useAutoPullGate(engine,')))
    for (const needle of ['state.cart.length', 'state.isCheckoutOpen', 'state.isProcessing', 'state.isSuccessOpen',
      'refundOrder', 'refundSale', 'isRefunding', 'showReceive', 'pendingReceive', 'pendingTT', 'pendingFulfillment',
      'isAddingCustomer', 'state.activeAdjustment', 'showHistory', 'showLocalReceipts', 'showRecap',
      'showTransferHistory', 'showSettings', 'showMenu', 'shiftPrompt', 'closeIntent', 'isSavingCustomer',
      'state.selectedCustomer', 'state.selectedSalesman', 'state.appliedPromotions', 'state.appliedPromoCodes', 'state.pointsToRedeem']) {
      expect(call).toContain(needle) // fed from live state inside the hook call, not merely used elsewhere
    }
  })
})
