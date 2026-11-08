import { describe, expect, it } from 'vitest'
import {
  UNBOUNDED_DAY, carriedDays, dateRangeError, isAnswerFor, dayOf, dayToQuery, enumOf, isDay, pageOf, pageSizeOf, pageToClamp, totalPagesOf, paymentOf, uuidOf, withCurrent,
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
  it('passes the ids Settings can create, punctuation included', () => {
    expect(paymentOf('qris')).toBe('qris')
    expect(paymentOf('e_wallet-1')).toBe('e_wallet-1')
    expect(paymentOf('debit/kredit_bca')).toBe('debit/kredit_bca')
    expect(paymentOf('e-wallet_(ovo)')).toBe('e-wallet_(ovo)')
    expect(paymentOf('x'.repeat(64))).toBe('x'.repeat(64))
  })
  it('drops empty, over-long and control-character values', () => {
    expect(paymentOf('')).toBe('')
    expect(paymentOf('   ')).toBe('')
    expect(paymentOf('x'.repeat(65))).toBe('')
    expect(paymentOf('a\nb')).toBe('')
    expect(paymentOf('a\u0000b')).toBe('')
  })
  it('trims surrounding spaces', () => {
    expect(paymentOf(' qris ')).toBe('qris')
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
  it('accepts a year typed digit by digit (Date.UTC would map 0-99 to 1900s)', () => {
    expect(isDay('0002-10-01')).toBe(true)
    expect(isDay('0020-10-01')).toBe(true)
    expect(isDay('0202-10-01')).toBe(true)
    expect(isDay('0000-02-29')).toBe(true)
    expect(isDay('0001-02-29')).toBe(false)
    expect(isDay('0100-02-29')).toBe(false)
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

describe('isAnswerFor', () => {
  it('is true only for the answer to the page on show', () => {
    expect(isAnswerFor({ page: 4, limit: 50 }, 4, 50)).toBe(true)
    expect(isAnswerFor({ page: 1, limit: 50 }, 4, 50)).toBe(false)
    expect(isAnswerFor({ page: 4, limit: 25 }, 4, 50)).toBe(false)
  })
  it('ignores the limit for a fixed-size list and rejects a missing meta', () => {
    expect(isAnswerFor({ page: 2, limit: 50 }, 2)).toBe(true)
    expect(isAnswerFor({ page: 1 }, 2)).toBe(false)
    expect(isAnswerFor(undefined, 1)).toBe(false)
    expect(isAnswerFor(null, 1, 50)).toBe(false)
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

describe('totalPagesOf', () => {
  it('counts pages and never drops below one', () => {
    expect(totalPagesOf(0, 50)).toBe(1)
    expect(totalPagesOf(50, 50)).toBe(1)
    expect(totalPagesOf(51, 50)).toBe(2)
    expect(totalPagesOf(120, 50)).toBe(3)
  })
  it('treats a bad limit or total as one page', () => {
    expect(totalPagesOf(10, 0)).toBe(1)
    expect(totalPagesOf(Number.NaN, 50)).toBe(1)
  })
})

describe('dateRangeError (F10)', () => {
  it('flags a start after the end', () => {
    expect(dateRangeError('2026-11-09', '2026-11-01')).toMatch(/lebih akhir/)
  })
  it('accepts equal days, ordered days and unbounded ends', () => {
    expect(dateRangeError('2026-11-01', '2026-11-01')).toBeNull()
    expect(dateRangeError('2026-11-01', '2026-11-09')).toBeNull()
    expect(dateRangeError('', '2026-11-01')).toBeNull()
    expect(dateRangeError('2026-11-09', '')).toBeNull()
  })
})
