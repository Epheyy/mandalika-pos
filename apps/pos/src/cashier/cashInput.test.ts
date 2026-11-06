import { describe, expect, it } from 'vitest'
import { cashTender } from './tender'
import { formatCashInput, MAX_CASH_DIGITS, nextCashInput, parseCashInput, parseTypedCash, pastedCashInput, caretAfterDigits } from './cashInput'

describe('parseCashInput', () => {
  it('reads a typed id-ID amount as plain digits', () => {
    expect(parseCashInput('350.000')).toBe('350000')
    expect(parseCashInput('Rp 350.000')).toBe('350000')
    expect(parseCashInput('1.250.000')).toBe('1250000')
    expect(parseCashInput('350000')).toBe('350000')
  })

  it('treats empty and non-numeric input as empty (empty means exact cash)', () => {
    expect(parseCashInput('')).toBe('')
    expect(parseCashInput('   ')).toBe('')
    expect(parseCashInput('Rp')).toBe('')
    expect(parseCashInput('Rp ')).toBe('')
    expect(parseCashInput('abc')).toBe('')
    expect(parseCashInput('-')).toBe('')
  })

  it('keeps a typed zero as "0" (short, never silently exact cash)', () => {
    expect(parseCashInput('0')).toBe('0')
    expect(parseCashInput('Rp 0')).toBe('0')
    expect(parseCashInput('000')).toBe('0')
    expect(parseCashInput('0350000')).toBe('350000')
  })

  it('handles pasted text with spaces, currency symbol and stray characters', () => {
    expect(parseCashInput(' Rp 350.000 ')).toBe('350000')
    expect(parseCashInput('Rp\u00a0350.000')).toBe('350000')
    expect(parseCashInput('350 000')).toBe('350000')
    expect(parseCashInput('IDR 1,250,000')).toBe('1250000')
    expect(parseCashInput('350.000abc')).toBe('350000')
  })

  it('never reads a pasted fraction as extra zeros', () => {
    expect(parseCashInput('350.50')).toBe('350')
    expect(parseCashInput('350,5')).toBe('350')
    expect(parseCashInput('350.000,00')).toBe('350000')
    expect(parseCashInput('1.5')).toBe('1')
  })

  it('rejects an amount longer than the maximum (returns null)', () => {
    const max = '9'.repeat(MAX_CASH_DIGITS)
    expect(parseCashInput(max)).toBe(max)
    expect(parseCashInput(`${max}9`)).toBeNull()
    expect(parseCashInput('1.000.000.000.000.000')).toBeNull()
  })
})

describe('parseTypedCash', () => {
  it('reads the formatted field text after a keystroke or a deletion', () => {
    expect(parseTypedCash('Rp 350.000')).toBe('350000')
    expect(parseTypedCash('Rp 1.00')).toBe('100') // one character deleted from Rp 1.000
    expect(parseTypedCash('Rp 1.0000')).toBe('10000') // one zero typed after Rp 1.000
    expect(parseTypedCash('Rp ')).toBe('')
    expect(parseTypedCash('Rp 0')).toBe('0')
  })
  it('rejects over the maximum', () => {
    expect(parseTypedCash('9'.repeat(MAX_CASH_DIGITS + 1))).toBeNull()
  })
})

describe('formatCashInput', () => {
  it('shows the raw digits as Rp with id-ID grouping', () => {
    expect(formatCashInput('350000')).toBe('Rp 350.000')
    expect(formatCashInput('1250000')).toBe('Rp 1.250.000')
    expect(formatCashInput('5')).toBe('Rp 5')
    expect(formatCashInput('0')).toBe('Rp 0')
  })
  it('shows nothing for empty so the exact-total placeholder is visible', () => {
    expect(formatCashInput('')).toBe('')
  })
  it('round-trips through the parser', () => {
    for (const raw of ['0', '5', '350000', '1250000', '999999999999']) {
      expect(parseCashInput(formatCashInput(raw))).toBe(raw)
    }
  })
})

describe('nextCashInput', () => {
  it('returns the new raw digits when the text is acceptable', () => {
    expect(nextCashInput('35000', 'Rp 350.000')).toBe('350000')
    expect(nextCashInput('', 'Rp 5')).toBe('5')
  })
  it('clearing the field gives empty (exact cash)', () => {
    expect(nextCashInput('5', 'Rp ')).toBe('')
    expect(nextCashInput('350000', '')).toBe('')
  })
  it('keeps the current value when the text is over the maximum', () => {
    const max = '9'.repeat(MAX_CASH_DIGITS)
    expect(nextCashInput(max, formatCashInput(max) + '9')).toBe(max)
  })
})

describe('pastedCashInput', () => {
  it('reads a pasted amount and keeps the current value when it is too long', () => {
    expect(pastedCashInput('', 'Rp 350.000')).toBe('350000')
    expect(pastedCashInput('5', '350.50')).toBe('350')
    expect(pastedCashInput('5', '9'.repeat(MAX_CASH_DIGITS + 1))).toBe('5')
    expect(pastedCashInput('100000', 'abc')).toBe('100000')
  })
})

describe('same entered amount, same tender as before', () => {
  it.each([
    ['', 350000],
    ['350000', 350000],
    ['400000', 350000],
    ['100000', 350000],
    ['0', 350000],
  ])('cashTender(%j) is unchanged by the format round trip', (raw, total) => {
    const viaField = nextCashInput('', formatCashInput(raw))
    expect(viaField).toBe(raw)
    expect(cashTender(true, viaField, total)).toEqual(cashTender(true, raw, total))
  })
})

describe('caretAfterDigits', () => {
  it('keeps the caret after the same digit once the text is re-formatted', () => {
    // "Rp 1.500.000" with backspace after the 1 -> "Rp 500.000", caret belongs before the 5
    expect(caretAfterDigits('Rp 500.000', 0)).toBe(3)
    expect(caretAfterDigits('Rp 500.000', 1)).toBe(4)
    expect(caretAfterDigits('Rp 500.000', 4)).toBe(8)
    expect(caretAfterDigits('Rp 500.000', 6)).toBe(10)
  })
  it('falls back to the end and handles an empty field', () => {
    expect(caretAfterDigits('Rp 5', 9)).toBe(4)
    expect(caretAfterDigits('', 0)).toBe(0)
  })
})
