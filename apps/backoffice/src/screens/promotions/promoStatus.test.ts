import { describe, expect, it } from 'vitest'
import { promoStatus, wibDay } from './promoStatus'

describe('wibDay', () => {
  it('rolls over at 17:00 UTC, the WIB midnight', () => {
    expect(wibDay(new Date('2026-11-03T16:59:59Z'))).toBe('2026-11-03')
    expect(wibDay(new Date('2026-11-03T17:00:00Z'))).toBe('2026-11-04')
  })

  it('crosses a month and a year end', () => {
    expect(wibDay(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01')
    expect(wibDay(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01')
  })

  it('does not depend on the browser time zone (same instant, same day)', () => {
    const instant = new Date('2026-11-03T20:30:00Z')
    expect(wibDay(instant)).toBe('2026-11-04')
  })
})

describe('promoStatus (same precedence as the server status filter)', () => {
  const today = '2026-11-03'

  it('is nonaktif whenever isActive is false, even for an ended or future row', () => {
    expect(promoStatus({ isActive: false }, today)).toBe('nonaktif')
    expect(promoStatus({ isActive: false, endDate: '2026-01-01' }, today)).toBe('nonaktif')
    expect(promoStatus({ isActive: false, startDate: '2027-01-01' }, today)).toBe('nonaktif')
  })

  it('is aktif without dates, and on the first and last day', () => {
    expect(promoStatus({ isActive: true }, today)).toBe('aktif')
    expect(promoStatus({ isActive: true, startDate: null, endDate: null }, today)).toBe('aktif')
    expect(promoStatus({ isActive: true, startDate: today }, today)).toBe('aktif')
    expect(promoStatus({ isActive: true, endDate: today }, today)).toBe('aktif')
    expect(promoStatus({ isActive: true, startDate: today, endDate: today }, today)).toBe('aktif')
  })

  it('is berakhir the day after the end date', () => {
    expect(promoStatus({ isActive: true, endDate: '2026-11-02' }, today)).toBe('berakhir')
  })

  it('is terjadwal the day before the start date', () => {
    expect(promoStatus({ isActive: true, startDate: '2026-11-04' }, today)).toBe('terjadwal')
  })

  it('flips with the WIB business day, not the UTC day', () => {
    const row = { isActive: true, endDate: '2026-11-03' }
    expect(promoStatus(row, wibDay(new Date('2026-11-03T16:59:59Z')))).toBe('aktif')
    expect(promoStatus(row, wibDay(new Date('2026-11-03T17:00:00Z')))).toBe('berakhir')
    const starts = { isActive: true, startDate: '2026-11-04' }
    expect(promoStatus(starts, wibDay(new Date('2026-11-03T16:59:59Z')))).toBe('terjadwal')
    expect(promoStatus(starts, wibDay(new Date('2026-11-03T17:00:00Z')))).toBe('aktif')
  })
})
