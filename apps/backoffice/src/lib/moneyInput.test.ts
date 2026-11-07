import { describe, expect, it } from 'vitest'
import { formatMoneyInput, MAX_MONEY_DIGITS, nextMoneyInput, parseMoneyInput, parseTypedMoney, pastedMoneyInput, caretAfterDigits } from './moneyInput'

describe('parseMoneyInput', () => {
  it('reads a typed id-ID amount as plain digits', () => {
    expect(parseMoneyInput('350.000')).toBe('350000')
    expect(parseMoneyInput('Rp 350.000')).toBe('350000')
    expect(parseMoneyInput('1.250.000')).toBe('1250000')
    expect(parseMoneyInput('350000')).toBe('350000')
  })

  it('treats empty and non-numeric input as empty (empty means no amount)', () => {
    expect(parseMoneyInput('')).toBe('')
    expect(parseMoneyInput('   ')).toBe('')
    expect(parseMoneyInput('Rp')).toBe('')
    expect(parseMoneyInput('Rp ')).toBe('')
    expect(parseMoneyInput('abc')).toBe('')
    expect(parseMoneyInput('-')).toBe('')
  })

  it('keeps a typed zero as "0" (short, never silently empty)', () => {
    expect(parseMoneyInput('0')).toBe('0')
    expect(parseMoneyInput('Rp 0')).toBe('0')
    expect(parseMoneyInput('000')).toBe('0')
    expect(parseMoneyInput('0350000')).toBe('350000')
  })

  it('handles pasted text with spaces, currency symbol and stray characters', () => {
    expect(parseMoneyInput(' Rp 350.000 ')).toBe('350000')
    expect(parseMoneyInput('Rp\u00a0350.000')).toBe('350000')
    expect(parseMoneyInput('350 000')).toBe('350000')
    expect(parseMoneyInput('IDR 1,250,000')).toBe('1250000')
    expect(parseMoneyInput('350.000abc')).toBe('350000')
  })

  it('never reads a pasted fraction as extra zeros', () => {
    expect(parseMoneyInput('350.50')).toBe('350')
    expect(parseMoneyInput('350,5')).toBe('350')
    expect(parseMoneyInput('350.000,00')).toBe('350000')
    expect(parseMoneyInput('1.5')).toBe('1')
  })

  it('rejects an amount longer than the maximum (returns null)', () => {
    const max = '9'.repeat(MAX_MONEY_DIGITS)
    expect(parseMoneyInput(max)).toBe(max)
    expect(parseMoneyInput(`${max}9`)).toBeNull()
    expect(parseMoneyInput('1.000.000.000.000.000')).toBeNull()
  })
})

describe('parseTypedMoney', () => {
  it('reads the formatted field text after a keystroke or a deletion', () => {
    expect(parseTypedMoney('Rp 350.000')).toBe('350000')
    expect(parseTypedMoney('Rp 1.00')).toBe('100') // one character deleted from Rp 1.000
    expect(parseTypedMoney('Rp 1.0000')).toBe('10000') // one zero typed after Rp 1.000
    expect(parseTypedMoney('Rp ')).toBe('')
    expect(parseTypedMoney('Rp 0')).toBe('0')
  })
  it('rejects over the maximum', () => {
    expect(parseTypedMoney('9'.repeat(MAX_MONEY_DIGITS + 1))).toBeNull()
  })
})

describe('formatMoneyInput', () => {
  it('shows the raw digits as Rp with id-ID grouping', () => {
    expect(formatMoneyInput('350000')).toBe('Rp 350.000')
    expect(formatMoneyInput('1250000')).toBe('Rp 1.250.000')
    expect(formatMoneyInput('5')).toBe('Rp 5')
    expect(formatMoneyInput('0')).toBe('Rp 0')
  })
  it('shows nothing for empty so the placeholder is visible', () => {
    expect(formatMoneyInput('')).toBe('')
  })
  it('round-trips through the parser', () => {
    for (const raw of ['0', '5', '350000', '1250000', '999999999999']) {
      expect(parseMoneyInput(formatMoneyInput(raw))).toBe(raw)
    }
  })
})

describe('nextMoneyInput', () => {
  it('returns the new raw digits when the text is acceptable', () => {
    expect(nextMoneyInput('35000', 'Rp 350.000')).toBe('350000')
    expect(nextMoneyInput('', 'Rp 5')).toBe('5')
  })
  it('clearing the field gives empty (no amount)', () => {
    expect(nextMoneyInput('5', 'Rp ')).toBe('')
    expect(nextMoneyInput('350000', '')).toBe('')
  })
  it('keeps the current value when the text is over the maximum', () => {
    const max = '9'.repeat(MAX_MONEY_DIGITS)
    expect(nextMoneyInput(max, formatMoneyInput(max) + '9')).toBe(max)
  })
})

describe('pastedMoneyInput', () => {
  it('reads a pasted amount and keeps the current value when it is too long', () => {
    expect(pastedMoneyInput('', 'Rp 350.000')).toBe('350000')
    expect(pastedMoneyInput('5', '350.50')).toBe('350')
    expect(pastedMoneyInput('5', '9'.repeat(MAX_MONEY_DIGITS + 1))).toBe('5')
    expect(pastedMoneyInput('100000', 'abc')).toBe('100000')
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

describe('same entered price, same saved number as the plain number field', () => {
  it.each(['0', '5', '150000', '1250000', '999999999999'])('%s saves as Number(raw) after the format round trip', (raw) => {
    const viaField = nextMoneyInput('', formatMoneyInput(raw))
    expect(viaField).toBe(raw)
    expect(Number(viaField)).toBe(Number(raw))
  })
  it('an empty field stays empty (variant price 0, outlet price "use base")', () => {
    expect(nextMoneyInput('150000', formatMoneyInput(''))).toBe('')
  })
})
