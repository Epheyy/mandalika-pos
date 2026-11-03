import { describe, expect, it } from 'vitest'
import { outletPrefKey, readOutletPref, resolveOutletPref, writeOutletPref } from './outletPref'

const memory = () => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('outlet preference', () => {
  it('is keyed per user', () => {
    expect(outletPrefKey('u1')).toBe('mandalika.backoffice.outletId.u1')
    const s = memory()
    writeOutletPref('u1', 'outlet-a', s)
    expect(readOutletPref('u1', s)).toBe('outlet-a')
    expect(readOutletPref('u2', s)).toBeNull()
  })

  it('all outlets (null) clears it', () => {
    const s = memory()
    writeOutletPref('u1', 'outlet-a', s)
    writeOutletPref('u1', null, s)
    expect(readOutletPref('u1', s)).toBeNull()
    expect(s.data.size).toBe(0)
  })

  it('treats an empty stored value as none', () => {
    const s = memory()
    s.setItem(outletPrefKey('u1'), '')
    expect(readOutletPref('u1', s)).toBeNull()
  })

  it('survives blocked or missing storage', () => {
    const blocked = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(readOutletPref('u1', blocked)).toBeNull()
    expect(() => writeOutletPref('u1', 'x', blocked)).not.toThrow()
    expect(readOutletPref('u1', null)).toBeNull()
    expect(() => writeOutletPref('u1', 'x', null)).not.toThrow()
  })
})

describe('resolveOutletPref', () => {
  const list = [{ id: 'a' }, { id: 'b' }]
  it('applies a saved outlet that is still in the list', () => {
    expect(resolveOutletPref('b', list)).toEqual({ outletId: 'b', stale: false })
  })
  it('drops a saved outlet that is gone and says so', () => {
    expect(resolveOutletPref('gone', list)).toEqual({ outletId: null, stale: true })
  })
  it('does nothing without a saved outlet', () => {
    expect(resolveOutletPref(null, list)).toEqual({ outletId: null, stale: false })
  })
  it('keeps the preference when the list is empty (a failed fetch proves nothing)', () => {
    expect(resolveOutletPref('a', [])).toEqual({ outletId: null, stale: false })
  })
})
