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
