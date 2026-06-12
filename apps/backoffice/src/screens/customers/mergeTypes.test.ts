import { describe, it, expect } from 'vitest'
import { computeConflicts } from './mergeTypes'

const base = {
  id: 'k', name: 'Budi', phone: '0812', email: null, birthday: null,
  anniversary: null, notes: null, points: 0, totalSpent: 0, visitCount: 0,
  lastVisit: null, createdAt: '', segment: null, tags: null,
} as any

describe('computeConflicts', () => {
  it('returns no conflicts when editable fields match', () => {
    expect(computeConflicts(base, { ...base, id: 'd' })).toEqual([])
  })
  it('flags a differing name with keeper default', () => {
    const c = computeConflicts(base, { ...base, id: 'd', name: 'Budi S' })
    expect(c).toEqual([{ field: 'name', keeper: 'Budi', dup: 'Budi S', default: 'keeper' }])
  })
  it('defaults to dup when keeper value is empty and dup is set', () => {
    const c = computeConflicts({ ...base, email: null }, { ...base, id: 'd', email: 'x@y.id' })
    expect(c).toEqual([{ field: 'email', keeper: null, dup: 'x@y.id', default: 'dup' }])
  })
  it('does not flag when only a non-editable field differs (points)', () => {
    expect(computeConflicts(base, { ...base, id: 'd', points: 99 })).toEqual([])
  })
})
