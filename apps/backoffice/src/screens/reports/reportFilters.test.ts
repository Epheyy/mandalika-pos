import { describe, expect, it } from 'vitest'
import {
  UNBOUNDED_DAY, carriedDays, dayOf, dayToQuery, enumOf, isDay, pageOf, pageSizeOf, pageToClamp, paymentOf, uuidOf, withCurrent,
} from './reportFilters'

describe('pageOf / pageSizeOf', () => {
  it('floors hal at 1 and rounds down', () => {
    expect(pageOf(-3)).toBe(1)
    expect(pageOf(0)).toBe(1)
    expect(pageOf(2.9)).toBe(2)
    expect(pageOf(NaN)).toBe(1)
    expect(pageOf(Number.POSITIVE_INFINITY)).toBe(1)
    expect(pageOf(7)).toBe(7)
  })
  it('caps an absurd page', () => {
    expect(pageOf(1e21)).toBe(100000)
  })
  it('accepts only the pager sizes', () => {
    expect(pageSizeOf(25)).toBe(25)
    expect(pageSizeOf(100)).toBe(100)
    expect(pageSizeOf(7)).toBe(50)
    expect(pageSizeOf(0)).toBe(50)
  })
})

describe('enumOf', () => {
  it('keeps a known value and falls back for junk', () => {
    expect(enumOf('refunded', ['completed', 'refunded'] as const, '' as 'completed' | 'refunded' | '')).toBe('refunded')
    expect(enumOf('zzz', ['completed', 'refunded'] as const, '' as 'completed' | 'refunded' | '')).toBe('')
  })
})

describe('uuidOf / paymentOf', () => {
  it('passes a uuid and drops anything else', () => {
    const id = '00000000-0000-4000-8f6b-0000000000a1'
    expect(uuidOf(id)).toBe(id)
    expect(uuidOf('../x')).toBe('')
    expect(uuidOf('zzz')).toBe('')
  })
  it('passes short id words and drops the rest', () => {
    expect(paymentOf('qris')).toBe('qris')
    expect(paymentOf('e_wallet-1')).toBe('e_wallet-1')
    expect(paymentOf('a b')).toBe('')
    expect(paymentOf('<script>')).toBe('')
    expect(paymentOf('x'.repeat(65))).toBe('')
  })
})

describe('withCurrent', () => {
  const opts = [{ id: 'cash', label: 'Tunai' }]
  it('adds an unknown current value so the select matches the filter', () => {
    expect(withCurrent(opts, 'gopay')).toEqual([...opts, { id: 'gopay', label: 'gopay' }])
  })
  it('leaves the options alone when the value is listed or empty', () => {
    expect(withCurrent(opts, 'cash')).toEqual(opts)
    expect(withCurrent(opts, '')).toEqual(opts)
  })
})

describe('isDay / dayOf / dayToQuery', () => {
  it('recognises real days only', () => {
    expect(isDay('2026-11-04')).toBe(true)
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('2026-1-1')).toBe(false)
    expect(isDay('zzz')).toBe(false)
  })
  it('uses the fallback for absent or junk values', () => {
    expect(dayOf('', '2026-11-04')).toBe('2026-11-04')
    expect(dayOf('nope', '2026-11-04')).toBe('2026-11-04')
    expect(dayOf('2026-10-01', '2026-11-04')).toBe('2026-10-01')
  })
  it('keeps a cleared date input as "no bound", not the default', () => {
    expect(dayOf(UNBOUNDED_DAY, '2026-11-04')).toBe('')
    expect(dayToQuery('')).toBe(UNBOUNDED_DAY)
    expect(dayToQuery('2026-10-01')).toBe('2026-10-01')
    expect(dayOf(dayToQuery(''), '2026-11-04')).toBe('')
  })
})

describe('pageToClamp', () => {
  it('leaves page 1 and in-range pages alone', () => {
    expect(pageToClamp(1, 0, 50)).toBeNull()
    expect(pageToClamp(2, 120, 50)).toBeNull()
    expect(pageToClamp(3, 120, 50)).toBeNull()
  })
  it('moves a page past the end to the last page, or 1 when nothing matches', () => {
    expect(pageToClamp(4, 120, 50)).toBe(3)
    expect(pageToClamp(99, 120, 50)).toBe(3)
    expect(pageToClamp(2, 0, 50)).toBe(1)
    expect(pageToClamp(2, 50, 50)).toBe(1)
  })
})

describe('carriedDays', () => {
  const query = { dari: '2026-10-01', sampai: '2026-10-31', status: 'refunded', hal: '3', tanda: 'any' }
  it('carries only the dates between the tabs that share them', () => {
    expect(carriedDays(query, 'export', 'refund')).toEqual({ dari: '2026-10-01', sampai: '2026-10-31' })
  })
  it('drops them when Transaksi is on either side (it has its own window)', () => {
    expect(carriedDays(query, 'orders', 'export')).toEqual({})
    expect(carriedDays(query, 'export', 'orders')).toEqual({})
  })
  it('passes absent dates through as undefined', () => {
    expect(carriedDays({}, 'export', 'shifts')).toEqual({ dari: undefined, sampai: undefined })
  })
})
