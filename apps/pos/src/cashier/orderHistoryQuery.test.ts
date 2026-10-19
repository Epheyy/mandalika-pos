import { describe, expect, it } from 'vitest'
import { businessToday, defaultHistoryDay, orderHistoryQuery } from './orderHistoryQuery'

describe('orderHistoryQuery', () => {
  it('sends business-day dateFrom/dateTo and never the legacy UTC from/to', () => {
    const { qs } = orderHistoryQuery('2026-10-19', '2026-10-20', 2, '')
    const p = new URLSearchParams(qs)
    expect(p.get('dateFrom')).toBe('2026-10-19')
    expect(p.get('dateTo')).toBe('2026-10-20')
    expect(p.has('from')).toBe(false)
    expect(p.has('to')).toBe(false)
    expect(p.get('page')).toBe('2')
    expect(p.has('q')).toBe(false)
  })
  it('adds the search term', () => {
    expect(new URLSearchParams(orderHistoryQuery('2026-10-19', '2026-10-19', 1, 'budi').qs).get('q')).toBe('budi')
  })
  it('cache key cannot collide with the legacy UTC-day key shape', () => {
    const { cacheKey } = orderHistoryQuery('2026-10-19', '2026-10-19', 1, '')
    expect(cacheKey).toBe('orders:bd:2026-10-19:2026-10-19:1:')
    expect(cacheKey).not.toBe('orders:2026-10-19:2026-10-19:1:')
  })
})

describe('businessToday', () => {
  const at = new Date('2026-10-19T16:30:00Z') // 23:30 WIB 10-19, 00:30 WITA 10-20
  it('follows the outlet zone, not the UTC date or the device zone', () => {
    expect(businessToday(at, 'Asia/Jakarta')).toBe('2026-10-19')
    expect(businessToday(at, 'Asia/Makassar')).toBe('2026-10-20')
    expect(businessToday(new Date('2026-10-19T20:00:00Z'), 'Asia/Jakarta')).toBe('2026-10-20') // UTC date would say 19
  })
  it('defaults to Asia/Jakarta when the bundle has no timezone', () => {
    expect(businessToday(at)).toBe('2026-10-19')
    expect(businessToday(at, null)).toBe('2026-10-19')
  })
})

describe('defaultHistoryDay', () => {
  const now = new Date('2026-10-20T03:00:00Z') // 10:00 WIB 10-20
  it('opens on the shift business day when a shift opened yesterday is still open', () => {
    expect(defaultHistoryDay(now, 'Asia/Jakarta', '2026-10-19T08:00:00Z')).toBe('2026-10-19')
  })
  it('reads the shift open time in the outlet zone, not UTC', () => {
    expect(defaultHistoryDay(now, 'Asia/Makassar', '2026-10-19T16:30:00Z')).toBe('2026-10-20') // 00:30 WITA
    expect(defaultHistoryDay(now, 'Asia/Jakarta', '2026-10-19T16:30:00Z')).toBe('2026-10-19') // 23:30 WIB
  })
  it('falls back to outlet-zone today without a usable shift', () => {
    expect(defaultHistoryDay(now, 'Asia/Jakarta')).toBe('2026-10-20')
    expect(defaultHistoryDay(now, 'Asia/Jakarta', null)).toBe('2026-10-20')
    expect(defaultHistoryDay(now, 'Asia/Jakarta', 'garbage')).toBe('2026-10-20')
  })
})
