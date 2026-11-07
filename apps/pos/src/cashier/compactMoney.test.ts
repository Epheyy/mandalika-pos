import { describe, expect, it } from 'vitest'
import { compactRupiah } from './compactMoney'

describe('compactRupiah', () => {
  it('shortens millions with one decimal and drops a trailing ,0', () => {
    expect(compactRupiah(5_900_000)).toBe('Rp 5,9 jt')
    expect(compactRupiah(2_000_000)).toBe('Rp 2 jt')
    expect(compactRupiah(2_500_000)).toBe('Rp 2,5 jt')
  })
  it('shortens thousands to rb', () => {
    expect(compactRupiah(350_000)).toBe('Rp 350 rb')
  })
  it('promotes to the next unit instead of printing 1000 rb / 1000 jt', () => {
    expect(compactRupiah(999_500)).toBe('Rp 1 jt')
    expect(compactRupiah(999_499)).toBe('Rp 999 rb')
    expect(compactRupiah(999_950_000)).toBe('Rp 1 M')
    expect(compactRupiah(1_500_000_000)).toBe('Rp 1,5 M')
  })
  it('keeps small amounts and zero in full', () => {
    expect(compactRupiah(0)).toContain('0')
    expect(compactRupiah(500)).toContain('500')
  })
  it('does not break on a non-finite amount', () => {
    expect(compactRupiah(Number.NaN)).toContain('0')
  })
})
