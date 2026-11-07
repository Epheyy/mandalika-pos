import { describe, expect, it } from 'vitest'
import { countedRaw, MAX_NOTE_COUNT, parseNoteCount, withCountedRaw } from './recapEntry'
import { nextCashInput, pastedCashInput, formatCashInput } from './cashInput'
import { differenceLines, recapRows } from './recapRows'

describe('withCountedRaw (Terhitung entry)', () => {
  it('stores the whole-rupiah amount of the raw digits', () => {
    expect(withCountedRaw({}, 'cash', '1000000')).toEqual({ cash: 1000000 })
  })
  it('keeps a typed zero as a counted zero and clears only on empty', () => {
    expect(withCountedRaw({ cash: 5 }, 'cash', '0')).toEqual({ cash: 0 })
    expect(withCountedRaw({ cash: 5, qris: 9 }, 'cash', '')).toEqual({ qris: 9 })
  })
  it('never mutates the previous map', () => {
    const prev = Object.freeze({ cash: 1 })
    expect(withCountedRaw(prev, 'qris', '2')).toEqual({ cash: 1, qris: 2 })
    expect(prev).toEqual({ cash: 1 })
  })
  it('round-trips through the shown field text', () => {
    const counted = withCountedRaw({}, 'cash', '2470000')
    expect(formatCashInput(countedRaw(counted, 'cash'))).toBe('Rp 2.470.000')
    expect(countedRaw({}, 'cash')).toBe('')
  })
  it('typed or pasted "Rp 1.000.000" gives the same counted amount as plain digits', () => {
    const typed = withCountedRaw({}, 'cash', nextCashInput('', 'Rp 1.000.000'))
    const pasted = withCountedRaw({}, 'cash', pastedCashInput('', 'Rp 1.000.000'))
    expect(typed).toEqual({ cash: 1000000 })
    expect(pasted).toEqual(typed)
    expect(withCountedRaw({}, 'cash', nextCashInput('', '1000000'))).toEqual(typed)
  })
  it('selisih is identical for formatted and plain entry', () => {
    const rows = recapRows([{ id: 'cash', label: 'Tunai', isEnabled: true }], { cash: 2475001 })
    const formatted = withCountedRaw({}, 'cash', pastedCashInput('', 'Rp 2.470.000'))
    const plain = withCountedRaw({}, 'cash', '2470000')
    expect(differenceLines(rows, formatted)).toEqual(differenceLines(rows, plain))
    expect(differenceLines(rows, formatted)[0]?.diff).toBe(-5001)
  })
})

describe('parseNoteCount', () => {
  it('reads digits only', () => {
    expect(parseNoteCount('20')).toBe(20)
    expect(parseNoteCount('Rp 3')).toBe(3)
    expect(parseNoteCount('')).toBe(0)
    expect(parseNoteCount('abc')).toBe(0)
  })
  it('caps at the maximum note count', () => {
    expect(parseNoteCount('99999')).toBe(MAX_NOTE_COUNT)
    expect(parseNoteCount('12345678901234')).toBe(MAX_NOTE_COUNT)
  })
})
