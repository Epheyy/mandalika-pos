import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Review H2 (Opus): Android Back is registered in an effect and the handler closes over `state`. If the split lines are
// not among the effect's dependencies the closure keeps `splitMode=false` and Back drops charged payment lines without
// the D-63 reminder. The same wiring-pin style as localReceipts.wiring.test.ts.
const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')

describe('Back handler sees the split payment lines', () => {
  const start = src.indexOf('setBackHandler(() => {')
  const end = src.indexOf('return () => setBackHandler(null)')
  const effect = src.slice(start, end)
  const deps = src.slice(end, src.indexOf('])', end))

  it('asks before closing checkout while payment lines are entered', () => {
    expect(effect).toContain("if (state.splitMode && state.tenders.length > 0)")
    expect(effect).toContain("Pastikan transaksi di mesin EDC/QRIS dibatalkan")
  })
  it('re-registers when the split state changes', () => {
    expect(deps).toContain('state.splitMode')
    expect(deps).toContain('state.tenders')
  })
})
