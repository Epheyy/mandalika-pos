import { describe, expect, it } from 'vitest'
import { STOCK_PENDING_SHOW_MS, stockPendingSince, stockPendingVisible } from './useStockPending'

describe('stock pending hold-off', () => {
  it('stays quiet until the drift has lasted the hold-off, then shows', () => {
    const since = stockPendingSince(null, true, 1000)
    expect(since).toBe(1000)
    expect(stockPendingVisible(since, 1000 + STOCK_PENDING_SHOW_MS - 1)).toBe(false)
    expect(stockPendingVisible(since, 1000 + STOCK_PENDING_SHOW_MS)).toBe(true)
  })
  it('keeps the first-seen time while pending and resets when it clears', () => {
    expect(stockPendingSince(1000, true, 9000)).toBe(1000)
    expect(stockPendingSince(1000, false, 9000)).toBeNull()
    expect(stockPendingVisible(null, 9e9)).toBe(false)
  })
})
