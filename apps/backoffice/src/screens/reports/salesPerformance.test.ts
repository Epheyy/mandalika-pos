import { describe, expect, it } from 'vitest'
import {
  RATINGS_PAGE_SIZE, avgText, monthOfDay, monthRange, percentText, ratingFlags, ratingTagLabel, ratingsParams,
  ratingsSalesmanFilter, salesmanLabel, starShares,
} from './salesPerformance'

describe('salesPerformance helpers', () => {
  it('monthRange gives the first and last day, leap years included', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(monthRange('2026-02')?.to).toBe('2026-02-28')
    expect(monthRange('')).toBeNull()
    expect(monthRange('2026-13')).toBeNull()
  })
  it('monthOfDay takes the month of a business day', () => {
    expect(monthOfDay('2026-11-27')).toBe('2026-11')
    expect(monthOfDay('semua')).toBe('')
  })
  it('formats percent and average', () => {
    expect(percentText(0.4286)).toBe('43%')
    expect(percentText(NaN)).toBe('0%')
    expect(avgText(4.256)).toBe('4,3')
    expect(avgText(undefined)).toBe('-')
  })
  it('starShares sums to 100 or is all zero', () => {
    expect(starShares([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0])
    const s = starShares([1, 0, 0, 1, 2])
    expect(s).toEqual([25, 0, 0, 25, 50])
    expect(starShares([1])).toEqual([100, 0, 0, 0, 0])
  })
  it('names the Tanpa sales row and filters it with "none"', () => {
    expect(salesmanLabel({ salesmanName: 'x' })).toBe('Tanpa sales')
    expect(salesmanLabel({ salesmanId: 'u1', salesmanName: 'Rina' })).toBe('Rina')
    expect(ratingsSalesmanFilter({})).toBe('none')
    expect(ratingsSalesmanFilter({ salesmanId: 'u1' })).toBe('u1')
  })
  it('builds drill-down params, omitting empty outlet and unset flag', () => {
    expect(ratingsParams({ dateFrom: 'a', dateTo: 'b', outletId: '', salesmanId: 'none', flaggedOnly: false, page: 2 })).toEqual({
      dateFrom: 'a', dateTo: 'b', salesmanId: 'none', page: 2, limit: RATINGS_PAGE_SIZE,
    })
    expect(ratingsParams({ dateFrom: 'a', dateTo: 'b', outletId: 'o1', salesmanId: 'u1', flaggedOnly: true, page: 1 })).toMatchObject({
      outletId: 'o1', flaggedOnly: true,
    })
  })
  it('labels tags and flags', () => {
    expect(ratingTagLabel('paham_produk')).toBe('Paham produk')
    expect(ratingTagLabel('zzz')).toBe('zzz')
    expect(ratingFlags({ flagFast: true, flagSameNetwork: true })).toHaveLength(2)
    expect(ratingFlags({ flagFast: false, flagSameNetwork: false })).toEqual([])
  })
})
