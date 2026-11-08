import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// F20: the Buka Shift field is the shared Rp field (digits only, so never below 0), not a type=number input.
describe('ShiftBar opening cash field', () => {
  const src = readFileSync(new URL('./ShiftBar.tsx', import.meta.url), 'utf8')
  it('uses CashAmountInput and no parseFloat', () => {
    expect(src).toMatch(/<CashAmountInput[\s\S]*id="shift-starting-cash"/)
    expect(src).not.toMatch(/parseFloat/)
    expect(src).not.toMatch(/id="shift-starting-cash"[\s\S]{0,80}type="number"/)
  })
})
