import { describe, expect, it } from 'vitest'
import { NEGATIVE_STARTING_CASH_BADGE, startingCashBadge } from './shiftFlags'

describe('startingCashBadge', () => {
  it('flags a shift the server marked as opened with a negative opening cash', () => {
    expect(startingCashBadge({ startingCashWarning: true })).toBe(NEGATIVE_STARTING_CASH_BADGE)
  })
  it('shows nothing for a normal shift, an older server (field absent) or false', () => {
    expect(startingCashBadge({})).toBeNull()
    expect(startingCashBadge({ startingCashWarning: false })).toBeNull()
  })
})
