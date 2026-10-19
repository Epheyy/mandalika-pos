import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guard (A05): the 12 h lock must sit at every place a new sale, refund or cash movement is
// committed. These are source checks because the screens are too heavy to mount in unit tests.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const body = (src: string, startMarker: string, endMarker: string) => {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker, a)
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('offline cap gates', () => {
  const cashier = read('../cashier/CashierScreen.tsx')
  it('gates add-to-cart', () => {
    expect(body(cashier, 'const addWithStockWarning', 'cartActions.addVariants')).toContain('offlineLock()')
  })
  it('gates checkout CONFIRM, not only add-to-cart', () => {
    expect(body(cashier, 'const handleConfirmPayment', 'saleGate.current.run')).toContain('offlineLock()')
  })
  it('gates the refund submit before anything is queued', () => {
    expect(body(cashier, 'const handleRefundConfirm', "engine.enqueue('refund'")).toContain('offlineLock()')
  })
  it('gates cash in/out before anything is queued', () => {
    const settings = read('../screens/SettingsScreen.tsx')
    expect(body(settings, 'const handleSaveCashFlow', "engine.enqueue('cash_flow'")).toContain('offlineLockMessage(engine.offlineState())')
  })
  it('does not gate shift close', () => {
    const useShift = read('../hooks/useShift.ts')
    expect(useShift).not.toContain('offlineLock')
  })
})
