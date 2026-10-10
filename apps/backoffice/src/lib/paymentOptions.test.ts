import { describe, expect, it } from 'vitest'
import { paymentFilterOptions } from './paymentOptions'

describe('paymentFilterOptions', () => {
  it('lists configured methods, the legacy cash id and unseen order methods once each', () => {
    const got = paymentFilterOptions(
      [{ id: 'tunai', label: 'Tunai' }, { id: 'qris', label: 'QRIS' }],
      [{ paymentMethod: 'QRIS' }, { paymentMethod: 'bca' }, { paymentMethod: 'cash' }],
    )
    expect(got.map((o) => o.id)).toEqual(['tunai', 'qris', 'cash', 'bca'])
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai')
  })
  it('falls back to cash alone without settings', () => {
    expect(paymentFilterOptions(undefined)).toEqual([{ id: 'cash', label: 'Tunai' }])
  })
  it('does not duplicate cash when it is configured', () => {
    expect(paymentFilterOptions([{ id: 'Cash', label: 'Tunai' }]).length).toBe(1)
  })
})
