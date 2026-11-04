import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// P-20 wiring pins: the draft must be tied to the sale's uuid and removed in the same gate that queues the sale.
const screen = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
const hook = readFileSync(new URL('./useOpenCartDraft.ts', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../auth.tsx', import.meta.url), 'utf8')

describe('open cart draft is tied to the sale gate (no double submit)', () => {
  const from = screen.indexOf('saleGate.current.run(')
  const gate = screen.slice(from, screen.indexOf("if (outcome.status === 'busy')", from))
  it('the draft carries the sale uuid before the enqueue, and the enqueue reuses that uuid', () => {
    const commit = gate.indexOf('openCart.commitBeforeSale(saleUuid)')
    const enqueue = gate.indexOf("engine.enqueue('order'")
    expect(commit).toBeGreaterThan(-1)
    expect(commit).toBeLessThan(enqueue)
    expect(gate).toContain('}, saleUuid)')
  })
  it('the draft is deleted inside the gate right after the enqueue resolved', () => {
    expect(gate.indexOf('openCart.clearForSale()')).toBeGreaterThan(gate.indexOf("engine.enqueue('order'"))
  })
  it('closing the shift clears the draft and the screen cart', () => {
    expect(screen).toMatch(/closed\) \{ await openCart\.clearForSale\(\); dispatch\(\{ type: 'CART_CLEAR' \}\) \}/)
  })
  it('hydration is skipped while a split draft is pending and drops sales already queued', () => {
    expect(screen).toContain('splitDraftOrderUuid: splitDraft.pending?.orderUuid ?? null')
    expect(screen).toMatch(/useOpenCartDraft\(\{[\s\S]*engine\.outbox\.all\(\)[\s\S]*engine\.localReceipts\(\)/)
  })
  it('never writes while the success view is open and never before the start-up decision', () => {
    expect(hook).toContain('if (!hydrated.current) return')
    expect(hook).toContain('else if (!state.isSuccessOpen)')
  })
  it('logout / session expiry / terminal release remove the draft', () => {
    expect(auth).toMatch(/const clear = useCallback\(\(\) => \{[\s\S]*openCartKey\(readBinding\(getKV\(\)\)\?\.outletId[\s\S]*authStore\.access = null/)
  })
})
