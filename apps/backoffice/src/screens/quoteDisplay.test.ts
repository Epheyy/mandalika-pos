import { describe, expect, it } from 'vitest'
import { quoteWarningTitle, receiptTotalLine } from './quoteDisplay'

const fmt = (n: number) => `Rp${n}`

describe('A10 quote display', () => {
  it('explains a mismatch with both totals and the signed difference', () => {
    expect(quoteWarningTitle({ quotedTotal: 100000, total: 110000, quoteWarningReason: 'quote_mismatch' }, fmt))
      .toBe('Total di struk Rp100000, total server Rp110000 (selisih -Rp10000)')
    expect(quoteWarningTitle({ quotedTotal: 112000, total: 110000, quoteWarningReason: 'quote_mismatch' }, fmt))
      .toBe('Total di struk Rp112000, total server Rp110000 (selisih +Rp2000)')
  })
  it('explains an unusable quote', () => {
    expect(quoteWarningTitle({ quotedTotal: null, total: 110000, quoteWarningReason: 'quote_invalid' }, fmt))
      .toBe('Total struk dari kasir tidak valid, dipakai total server')
  })
  it('falls back to the raw reason for an unknown code', () => {
    expect(quoteWarningTitle({ quotedTotal: null, total: 1, quoteWarningReason: 'x' }, fmt)).toBe('x')
  })
  it('shows "Total di struk" only for a real quote that differs', () => {
    expect(receiptTotalLine({ quotedTotal: 100000, total: 110000, quoteWarning: true }, fmt)).toBe('Rp100000')
    expect(receiptTotalLine({ quotedTotal: 110000, total: 110000, quoteWarning: false }, fmt)).toBeNull()
    expect(receiptTotalLine({ quotedTotal: null, total: 110000, quoteWarning: true }, fmt)).toBeNull()
    expect(receiptTotalLine({ total: 110000 }, fmt)).toBeNull()
  })
})
