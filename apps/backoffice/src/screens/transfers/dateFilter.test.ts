import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dayEndIso, dayStartIso } from '../../lib/businessDay'

// The transfer list filters are instants (created_at >= from AND < to), so a WIB day must start at 17:00Z the day before.
describe('transfer list date filters use the WIB business day', () => {
  it('maps 2026-11-24 to 2026-11-23T17:00:00Z .. 2026-11-24T17:00:00Z', () => {
    expect(dayStartIso('2026-11-24')).toBe('2026-11-23T17:00:00Z')
    expect(dayEndIso('2026-11-24')).toBe('2026-11-24T17:00:00Z')
  })

  it.each(['transfers/TransferList.tsx', 'ingredients/TransferTab.tsx'])('%s builds its range with dayStartIso/dayEndIso, not UTC midnight', (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(src).not.toContain('T00:00:00Z')
    expect(src).toContain('dayStartIso(')
    expect(src).toContain('dayEndIso(')
  })
})
