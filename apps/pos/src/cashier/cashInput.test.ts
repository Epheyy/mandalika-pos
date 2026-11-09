import { describe, expect, it } from 'vitest'
import { cashTender } from './tender'
import { formatCashInput, MAX_CASH_DIGITS, nextCashInput, parseCashInput, reduceCashKeystroke, parseTypedCash, pastedCashInput, caretAfterDigits } from './cashInput'

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

describe('one whole-rupiah rule for typing and pasting (F18)', () => {
  it('typed and pasted text give the same amount, never a magnified one', () => {
    const cases: Array<[string, string]> = [
      ['50000.5', '50000'],
      ['50000,5', '50000'],
      ['Rp 50.000,00', '50000'],
      ['Rp 50.000.5', '50000'],
      ['Rp 1.0000', '10000'],
    ]
    for (const [text, want] of cases) {
      expect(pastedCashInput('', text)).toBe(want)
      expect(nextCashInput('', text)).toBe(want)
    }
  })
  it('typing a fraction key by key leaves the amount alone (the field re-formats after every keystroke)', () => {
    expect(type('50000.5')).toBe('50000')
    expect(type('50000,50')).toBe('50000')
    expect(type('50000.')).toBe('50000')
    expect(type('50000')).toBe('50000')
    expect(type('0.5')).toBe('0')
    expect(type('.5', '50000')).toBe('50000')
  })
  it('a separator typed mid-string no longer shrinks the amount', () => {
    expect(reduceCashKeystroke('1000', 'Rp 1.0.00', { inputType: 'insertText', data: '.' }, null).raw).toBe('1000')
    expect(reduceCashKeystroke('50000', 'Rp 50.0,00', { inputType: 'insertText', data: ',' }, null).raw).toBe('50000')
  })
  it('deleting drops the pending digits and regroups', () => {
    const r = reduceCashKeystroke('1000', 'Rp 1.00', { inputType: 'deleteContentBackward', data: '' }, '00')
    expect(r).toEqual({ raw: '100', pending: null })
  })
  it('a deletion still regroups digits instead of reading a fraction', () => {
    expect(nextCashInput('1000', 'Rp 1.00')).toBe('100')
    expect(nextCashInput('1000', 'Rp .000')).toBe('0')
  })
})

/** Simulates the controlled field: every keystroke inserts one char at the end of the CURRENT formatted text. */
function typeKeys(keys: string, start = '', withInputType = true): { raw: string; pending: string | null } {
  let raw = start
  let pending: string | null = null
  for (const k of keys) {
    const r = reduceCashKeystroke(raw, formatCashInput(raw) + k, { inputType: withInputType ? 'insertText' : '', data: withInputType ? k : '' }, pending)
    raw = r.raw
    pending = r.pending
  }
  return { raw, pending }
}
function type(keys: string, start = ''): string {
  return typeKeys(keys, start).raw
}

describe('typed equals pasted: a separator + exactly three digits is a thousands group (F18 retest R10)', () => {
  const table: Array<[string, string]> = [
    ['50.000', '50000'],
    ['500.000', '500000'],
    ['1.000.000', '1000000'],
    ['50,000', '50000'],
    ['350.000,00', '350000'],
    ['50000.5', '50000'],
    ['50.5', '50'],
    ['50.00', '50'],
    ['1.2345', '12345'],
    ['50.0000', '500000'],
    ['12.500', '12500'],
    ['1.2345', '12345'],
  ]
  it.each(table)('%s gives %s whether typed (with or without inputType) or pasted', (text, want) => {
    expect(pastedCashInput('', text)).toBe(want)
    expect(typeKeys(text).raw).toBe(want)
    expect(typeKeys(text, '', false).raw).toBe(want)
  })
  it('holds the digits after a separator pending: the field never shows an amount the sale will not use', () => {
    expect(typeKeys('50.')).toEqual({ raw: '50', pending: '' })
    expect(typeKeys('50.0')).toEqual({ raw: '50', pending: '0' })
    expect(typeKeys('50.00')).toEqual({ raw: '50', pending: '00' })
    expect(typeKeys('50.000')).toEqual({ raw: '50000', pending: null })
  })
  it('another separator drops one or two pending digits', () => {
    expect(typeKeys('50.0,')).toEqual({ raw: '50', pending: '' })
    expect(type('50.0,000')).toBe('50000')
  })
  it('clearing the field and typing again starts from nothing', () => {
    const cleared = reduceCashKeystroke('50000', 'Rp ', { inputType: 'deleteContentBackward', data: '' }, null)
    expect(cleared).toEqual({ raw: '', pending: null })
    expect(type('50.000', cleared.raw)).toBe('50000')
  })
  it('backspace after a committed group regroups; backspace mid-fraction drops the pending digits', () => {
    expect(reduceCashKeystroke('50000', 'Rp 50.00', { inputType: 'deleteContentBackward', data: '' }, null).raw).toBe('5000')
    const mid = typeKeys('50.0')
    expect(reduceCashKeystroke(mid.raw, 'Rp 5', { inputType: 'deleteContentBackward', data: '' }, mid.pending)).toEqual({ raw: '5', pending: null })
  })
  it('replacing a selection with a digit starts a new amount even mid-fraction', () => {
    const mid = typeKeys('50.0')
    expect(reduceCashKeystroke(mid.raw, '7', { inputType: 'insertText', data: '7' }, mid.pending)).toEqual({ raw: '7', pending: null })
  })
  it('a digit typed mid-field after a separator is an ordinary digit, not a pending one', () => {
    const mid = typeKeys('50.')
    expect(reduceCashKeystroke('50', 'Rp 550', { inputType: 'insertText', data: '5' }, mid.pending).raw).toBe('550')
  })
  it('after blur (the hook resets pending to null) later digits are plain', () => {
    expect(type('7', typeKeys('50.00').raw)).toBe('507')
  })
  it('single keys reported as insertCompositionText are typed keys too', () => {
    let raw = ''
    let pending: string | null = null
    for (const k of '50.5') {
      const r = reduceCashKeystroke(raw, formatCashInput(raw) + k, { inputType: 'insertCompositionText', data: k }, pending)
      raw = r.raw
      pending = r.pending
    }
    expect(raw).toBe('50')
  })
  it('over the maximum the current amount stays and nothing is left pending', () => {
    const max = '9'.repeat(MAX_CASH_DIGITS)
    expect(typeKeys('.000', max)).toEqual({ raw: max, pending: null })
  })
})
