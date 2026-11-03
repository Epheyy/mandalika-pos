import { describe, expect, it } from 'vitest'
import { buildIngredientCountSaveItems } from './opnameSave'

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
