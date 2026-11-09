import { describe, expect, it } from 'vitest'
import { buildIngredientCountSaveItems, countInputLabel, parseCountInput, withCountEntry, withoutSavedEntries, unsavedEntryCount } from './opnameSave'

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('buildIngredientCountSaveItems', () => {
  it('sends only the lines entered in the draft', () => {
    expect(buildIngredientCountSaveItems(items, { b: 4 })).toEqual([{ itemId: 'b', counted: 4 }])
  })
  it('sends nothing when there is no draft, so no uncounted line is written as 0', () => {
    expect(buildIngredientCountSaveItems(items, {})).toEqual([])
  })
  it('keeps an explicitly entered 0 (a real count of zero)', () => {
    expect(buildIngredientCountSaveItems(items, { a: 0 })).toEqual([{ itemId: 'a', counted: 0 }])
  })
  it('never carries a previously saved value, so it cannot be overwritten with 0', () => {
    const saved = [{ id: 'a', counted: 9 }, { id: 'b' }]
    expect(buildIngredientCountSaveItems(saved, { b: 2 })).toEqual([{ itemId: 'b', counted: 2 }])
  })
  it('ignores draft entries for lines no longer on the count', () => {
    expect(buildIngredientCountSaveItems(items, { zzz: 3 })).toEqual([])
  })
})

describe('parseCountInput', () => {
  it('treats a cleared or half-typed box as uncounted, not 0', () => {
    expect(parseCountInput('')).toBeNull()
    expect(parseCountInput('-')).toBeNull()
  })
  it('keeps a real 0 and clamps negatives to 0', () => {
    expect(parseCountInput('0')).toBe(0)
    expect(parseCountInput('-3')).toBe(0)
    expect(parseCountInput('2.5')).toBe(2.5)
  })
})

describe('withCountEntry', () => {
  it('sets an entry and drops it again on null without mutating', () => {
    const d = { a: 1 }
    expect(withCountEntry(d, 'b', 2)).toEqual({ a: 1, b: 2 })
    expect(withCountEntry({ a: 1, b: 2 }, 'b', null)).toEqual({ a: 1 })
    expect(d).toEqual({ a: 1 })
  })
})

describe('withoutSavedEntries', () => {
  it('drops sent entries but keeps one edited while the save was in flight', () => {
    expect(withoutSavedEntries({ a: 5, b: 8, c: 1 }, [{ itemId: 'a', counted: 5 }, { itemId: 'b', counted: 7 }])).toEqual({ b: 8, c: 1 })
  })
})

describe('unsavedEntryCount', () => {
  const running = (id: string) => ({ id, status: 'in_progress' as const })

  it('is zero for an empty draft and for a count whose draft was emptied by a save', () => {
    expect(unsavedEntryCount({}, [running('a')])).toBe(0)
    expect(unsavedEntryCount({ a: {} }, [running('a')])).toBe(0)
  })

  it('adds up every edited row of every running count', () => {
    const draft = { a: { i1: 2.5, i2: 0, i3: 7 }, b: { j1: 1 } }
    expect(unsavedEntryCount(draft, [running('a'), running('b')])).toBe(4)
  })

  it('counts a zero as an entry (zero is a real count)', () => {
    expect(unsavedEntryCount({ a: { i1: 0 } }, [running('a')])).toBe(1)
  })

  it('ignores the draft of a count that is no longer running', () => {
    const draft = { a: { i1: 3 }, b: { j1: 1 } }
    expect(unsavedEntryCount(draft, [{ id: 'a', status: 'completed' }, running('b')])).toBe(1)
  })

  it('still counts a draft whose count is not on the listed page', () => {
    expect(unsavedEntryCount({ elsewhere: { i1: 3 } }, [running('a')])).toBe(1)
  })
})

describe('countInputLabel', () => {
  it('names the ingredient and unit so every row input is distinguishable', () => {
    expect(countInputLabel('Carrier', 'ml')).toBe('Jumlah dihitung Carrier (ml)')
    expect(countInputLabel('Carrier')).toBe('Jumlah dihitung Carrier')
    expect(countInputLabel('Carrier', 'ml')).not.toBe(countInputLabel('Alkohol', 'ml'))
  })
})
