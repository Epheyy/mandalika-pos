import { describe, expect, it } from 'vitest'
import { applyKey } from './cashKeypad'

describe('applyKey', () => {
  it('ignores leading zeros', () => {
    expect(applyKey('', '000')).toBe('')
    expect(applyKey('', '0')).toBe('')
    expect(applyKey('0', '5')).toBe('5')
  })
  it('appends digits', () => {
    expect(applyKey('1', '000')).toBe('1000')
    expect(applyKey('12', '0')).toBe('120')
  })
  it('backspace drops one digit', () => {
    expect(applyKey('5', '⌫')).toBe('')
    expect(applyKey('', '⌫')).toBe('')
    expect(applyKey('123', '⌫')).toBe('12')
  })
  it('ignores keys beyond 12 digits', () => {
    expect(applyKey('99999999999', '9')).toBe('999999999999')
    expect(applyKey('999999999999', '9')).toBe('999999999999')
    expect(applyKey('999999999999', '000')).toBe('999999999999')
  })
})
