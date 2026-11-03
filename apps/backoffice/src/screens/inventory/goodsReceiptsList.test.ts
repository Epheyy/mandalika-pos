import { describe, expect, it } from 'vitest'
import { locationFilter } from './GoodsReceiptsList'

describe('locationFilter', () => {
  it('splits the Lokasi value into the two list parameters', () => {
    expect(locationFilter('outlet:o1')).toEqual({ locationType: 'outlet', locationId: 'o1' })
    expect(locationFilter('warehouse:w1')).toEqual({ locationType: 'warehouse', locationId: 'w1' })
  })

  it('sends no location filter for the empty or a malformed value', () => {
    expect(locationFilter('')).toEqual({})
    expect(locationFilter('x:1')).toEqual({})
    expect(locationFilter('outlet:')).toEqual({})
  })
})
