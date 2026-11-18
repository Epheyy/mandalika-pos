import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Receipt designer Phase 5: the slips print through the outlet's template, and the REFUND slip never gets in the way of the refund.
describe('refund and void slip wiring', () => {
  const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('const handleRefundConfirm'), src.indexOf('// A08: only called after the server minted a grant'))

  it('prints the refund slip only after the refund was queued, not awaited, with the template layout', () => {
    expect(body.indexOf('printRefundSlipSafely(')).toBeGreaterThan(body.indexOf("outcome.status === 'failed'"))
    expect(body.indexOf('printRefundSlipSafely(')).toBeGreaterThan(body.indexOf("engine.enqueue('refund'"))
    expect(body).toMatch(/void printRefundSlipSafely\(/)
    expect(body).toContain('printer.printRefundSlip(data, settings.receipt, receiptLayout)')
  })

  it('builds the slip data before the refund is queued (the refund memory changes when it is)', () => {
    expect(body.indexOf('const slipCache = refundCacheFor(ids)')).toBeLessThan(body.indexOf("engine.enqueue('refund'"))
  })

  it('every void slip caller passes the outlet receiptLayout', () => {
    const calls = [...src.matchAll(/printVoidSlip\(/g)]
    expect(calls).toHaveLength(2)
    for (const m of calls) expect(src.slice(m.index, m.index + 400)).toContain('receiptLayout)')
  })
})
