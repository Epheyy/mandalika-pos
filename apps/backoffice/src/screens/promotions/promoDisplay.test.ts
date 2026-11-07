import { describe, expect, it } from 'vitest'
import { periodRangeText, promoMetaLine } from './promoDisplay'

describe('periodRangeText', () => {
  it('collapses a same-month range', () => expect(periodRangeText('2026-11-25', '2026-11-30')).toBe('25–30 Nov 2026'))
  it('spans months in one year', () => expect(periodRangeText('2026-11-28', '2026-12-03')).toBe('28 Nov – 3 Des 2026'))
  it('spans years', () => expect(periodRangeText('2026-12-28', '2027-01-03')).toBe('28 Des 2026 – 3 Jan 2027'))
  it('handles a single day', () => expect(periodRangeText('2026-11-25', '2026-11-25')).toBe('25 Nov 2026'))
  it('handles open ends', () => {
    expect(periodRangeText('2026-11-25', null)).toBe('Mulai 25 Nov 2026')
    expect(periodRangeText(null, '2026-11-30')).toBe('Sampai 30 Nov 2026')
    expect(periodRangeText(null, null)).toBe('Tanpa batas waktu')
  })
})

describe('promoMetaLine', () => {
  it('joins how, outlet scope and period', () => {
    expect(promoMetaLine({ autoApply: true, codeOnly: false, outletIds: [], startDate: '2026-11-25', endDate: '2026-11-30' })).toBe('Otomatis di kasir · Semua outlet · 25–30 Nov 2026')
  })
  it('names code-only and counts outlets', () => {
    expect(promoMetaLine({ autoApply: false, codeOnly: true, outletIds: ['a', 'b'], startDate: null, endDate: null })).toBe('Hanya dengan kode · 2 outlet · Tanpa batas waktu')
  })
})
