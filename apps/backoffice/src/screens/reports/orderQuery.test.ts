import { expect, it } from 'vitest'
import { lastDaysRange, orderFilterParams } from './orderQuery'

const empty = { dateFrom: '', dateTo: '', status: '', payment: '', q: '' }

it('omits empty filters so the range stays unbounded', () => {
  expect(orderFilterParams(empty)).toEqual({})
})

it('maps filters to server params and trims text', () => {
  expect(orderFilterParams({ dateFrom: '2026-03-01', dateTo: '2026-03-02', status: 'refunded', payment: ' QRIS ', q: ' ani ' }))
    .toEqual({ dateFrom: '2026-03-01', dateTo: '2026-03-02', status: 'refunded', paymentMethod: 'QRIS', q: 'ani' })
})

it('last-30-days is inclusive of today', () => {
  expect(lastDaysRange(30, new Date(2026, 2, 31, 10))).toEqual({ dateFrom: '2026-03-02', dateTo: '2026-03-31' })
})

import { canViewSummary, transaksiFilters, transaksiHeader } from './orderQuery'

const range = { dateFrom: '2026-03-02', dateTo: '2026-03-31' }

it('view_transactions alone cannot call the summary; view_reports and admin can', () => {
  expect(canViewSummary(false, ['view_transactions'])).toBe(false)
  expect(canViewSummary(false, ['view_reports'])).toBe(true)
  expect(canViewSummary(true, [])).toBe(true)
})

it('keeps the 30-day window without search and drops it for a search or "Semua tanggal"', () => {
  const base = { status: '', payment: '', q: '' }
  expect(transaksiFilters(range, false, base)).toMatchObject(range)
  expect(transaksiFilters(range, false, { ...base, q: 'ani' })).toMatchObject({ dateFrom: '', dateTo: '', q: 'ani' })
  expect(transaksiFilters(range, true, base)).toMatchObject({ dateFrom: '', dateTo: '' })
  expect(transaksiFilters(range, false, { ...base, q: '   ' })).toMatchObject(range)
})

it('shows a dash instead of 0 for an unloaded or unavailable count and total', () => {
  const fmt = (n: number) => `Rp${n}`
  expect(transaksiHeader(undefined, undefined, fmt)).toBe('– transaksi · Total: –')
  expect(transaksiHeader(3, undefined, fmt)).toBe('3 transaksi · Total: –')
  expect(transaksiHeader(0, 0, fmt)).toBe('0 transaksi · Total: Rp0')
})
