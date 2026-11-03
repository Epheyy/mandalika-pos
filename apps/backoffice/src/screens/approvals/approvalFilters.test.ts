import { describe, expect, it } from 'vitest'
import { approvalFilterOf, kindOf, outletOf } from './approvalFilters'

const ID = '3f2a9c1d-1111-4222-8333-444455556666'

describe('approvalFilters', () => {
  it('sends only the filters that were chosen', () => {
    expect(approvalFilterOf({ outlet: '', jenis: '' })).toEqual({})
    expect(approvalFilterOf({ outlet: ID, jenis: '' })).toEqual({ outletId: ID })
    expect(approvalFilterOf({ outlet: '', jenis: 'count' })).toEqual({ kind: 'count' })
    expect(approvalFilterOf({ outlet: ID, jenis: 'adjustment' })).toEqual({ outletId: ID, kind: 'adjustment' })
  })
  it('drops junk from a pasted link instead of sending it to the server', () => {
    expect(kindOf('opname')).toBe('')
    expect(outletOf('all')).toBe('')
    expect(outletOf('not-a-uuid')).toBe('')
    expect(approvalFilterOf({ outlet: 'x', jenis: 'y' })).toEqual({})
  })
})
