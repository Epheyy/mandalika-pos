import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEZONE, OUTLET_TIMEZONES, dayEndIso, dayStartIso, localDay } from './businessDay'

describe('localDay', () => {
  it('uses the local calendar day, not the UTC day', () => {
    // Local noon on 2026-10-19 is the 19th in every zone; the UTC date of local 00:30 can be the 18th.
    expect(localDay(new Date(2026, 9, 19, 0, 30))).toBe('2026-10-19')
    expect(localDay(new Date(2026, 9, 19, 23, 59))).toBe('2026-10-19')
  })
  it('zero-pads month and day', () => {
    expect(localDay(new Date(2026, 0, 5, 12))).toBe('2026-01-05')
  })
})

describe('OUTLET_TIMEZONES', () => {
  it('lists WIB, WITA and WIT with the zone value the server stores', () => {
    expect(OUTLET_TIMEZONES.map((z) => [z.label, z.value])).toEqual([
      ['WIB', 'Asia/Jakarta'],
      ['WITA', 'Asia/Makassar'],
      ['WIT', 'Asia/Jayapura'],
    ])
    expect(DEFAULT_TIMEZONE).toBe('Asia/Jakarta')
  })
})

describe('dayStartIso / dayEndIso', () => {
  it('Jakarta day starts 17:00Z the day before', () => {
    expect(dayStartIso('2026-10-19', 'Asia/Jakarta')).toBe('2026-10-18T17:00:00Z')
    expect(dayEndIso('2026-10-19', 'Asia/Jakarta')).toBe('2026-10-19T17:00:00Z')
  })
  it('Makassar day starts 16:00Z the day before', () => {
    expect(dayStartIso('2026-10-19', 'Asia/Makassar')).toBe('2026-10-18T16:00:00Z')
    expect(dayEndIso('2026-10-19', 'Asia/Makassar')).toBe('2026-10-19T16:00:00Z')
  })
  it('Jayapura day starts 15:00Z the day before', () => {
    expect(dayStartIso('2026-10-19', 'Asia/Jayapura')).toBe('2026-10-18T15:00:00Z')
  })
  it('crosses a month end', () => {
    expect(dayEndIso('2026-10-31', 'Asia/Jakarta')).toBe('2026-10-31T17:00:00Z')
    expect(dayStartIso('2026-11-01', 'Asia/Jakarta')).toBe('2026-10-31T17:00:00Z')
  })
  it('an unknown zone falls back to Jakarta', () => {
    expect(dayStartIso('2026-10-19', 'Mars/Base')).toBe('2026-10-18T17:00:00Z')
  })
})
