import { describe, expect, it } from 'vitest'
import { dashboardFetchWindow, periodInterval, prevInterval, wibDay } from './metrics'

describe('wibDay', () => {
  it('formats an instant as its Asia/Jakarta calendar day', () => {
    expect(wibDay(new Date('2026-03-01T16:59:00Z'))).toBe('2026-03-01')
    expect(wibDay(new Date('2026-03-01T17:01:00Z'))).toBe('2026-03-02')
  })
})

describe('dashboardFetchWindow', () => {
  const now = new Date('2026-03-10T05:00:00Z')

  it('leaves "all" unbounded', () => {
    expect(dashboardFetchWindow('all', now)).toEqual({})
  })

  it.each(['today', '7d', '30d'] as const)('%s covers current and previous interval (superset)', (period) => {
    const w = dashboardFetchWindow(period, now)
    const prev = prevInterval(period, now)!
    const iv = periodInterval(period, now)
    expect(w.dateFrom).toBeDefined()
    expect(w.dateTo).toBeDefined()
    // from is at or before the WIB day of the previous window start, minus a day of slack
    expect(w.dateFrom! <= wibDay(prev.start)).toBe(true)
    // to is at or after the WIB day of the interval end, plus a day of slack
    expect(w.dateTo! >= wibDay(iv.end)).toBe(true)
  })
})
