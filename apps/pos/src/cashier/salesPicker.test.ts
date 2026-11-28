import { describe, expect, it } from 'vitest'
import { salesPickList } from './salesPicker'

const staff = [{ id: 's1', name: 'Rina' }, { id: 's2', name: 'Dewi' }]
const users = [{ id: 'u1', displayName: 'Admin' }, { id: 'u2' }]

describe('salesPickList', () => {
  it('uses the sales staff list over users', () => {
    expect(salesPickList({ salesStaff: staff, users }, null)).toEqual(staff)
  })
  it('an empty staff list stays empty even when users exist', () => {
    expect(salesPickList({ salesStaff: [], users }, null)).toEqual([])
  })
  it('falls back to named users when the server sends no staff list', () => {
    expect(salesPickList({ users }, null)).toEqual([{ id: 'u1', name: 'Admin' }])
    expect(salesPickList({}, null)).toEqual([])
  })
  it('appends a selected salesperson who is not listed', () => {
    expect(salesPickList({ salesStaff: staff }, { id: 'old', name: 'Lama' })).toEqual([...staff, { id: 'old', name: 'Lama' }])
  })
  it('does not duplicate a selected salesperson who is listed', () => {
    expect(salesPickList({ salesStaff: staff }, { id: 's1', name: 'Rina' })).toEqual(staff)
  })
})
