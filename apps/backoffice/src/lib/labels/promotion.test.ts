import { describe, expect, it } from 'vitest'
import { DISCOUNT_CODE_TYPE, PROMOTION_STATUS, PROMOTION_TYPE, labelOf } from './index'

describe('promotion labels', () => {
  it('names every derived status the server filter accepts', () => {
    expect(Object.keys(PROMOTION_STATUS).sort()).toEqual(['aktif', 'berakhir', 'nonaktif', 'terjadwal'])
  })

  it('names every promotion type of the API', () => {
    expect(Object.keys(PROMOTION_TYPE).sort()).toEqual(['bogo', 'bundle', 'bundle_discount', 'buy_x_get_y', 'fixed', 'percentage', 'tiered'])
  })

  it('reads Lainnya for an unknown type, never the raw code', () => {
    expect(labelOf(PROMOTION_TYPE, 'mystery').label).toBe('Lainnya')
    expect(labelOf(DISCOUNT_CODE_TYPE, 'bogo').label).toBe('Lainnya')
  })
})
