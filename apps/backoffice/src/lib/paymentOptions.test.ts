import { describe, expect, it } from 'vitest'
import { paymentFilterOptions } from './paymentOptions'

describe('paymentFilterOptions', () => {
  it('lists configured methods, the legacy cash id and unseen order methods once each', () => {
    const got = paymentFilterOptions(
      [{ id: 'tunai', label: 'Tunai' }, { id: 'qris', label: 'QRIS' }],
      [{ paymentMethod: 'QRIS' }, { paymentMethod: 'bca' }, { paymentMethod: 'cash' }],
    )
    expect(got.map((o) => o.id)).toEqual(['tunai', 'qris', 'cash', 'bca', 'split'])
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai')
  })
  it('falls back to cash alone without settings', () => {
    expect(paymentFilterOptions(undefined)).toEqual([{ id: 'cash', label: 'Tunai' }, { id: 'split', label: 'Split-Payment' }])
  })
  it('does not duplicate cash when it is configured', () => {
    expect(paymentFilterOptions([{ id: 'Cash', label: 'Tunai' }]).map((o) => o.id)).toEqual(['Cash', 'split'])
  })
  it('offers Split-Payment once and never a raw split method id, configured or seen on an order', () => {
    const got = paymentFilterOptions(
      [{ id: 'Split', label: 'Bad' }, { id: 'qris', label: 'QRIS' }],
      [{ paymentMethod: 'split' }, { paymentMethod: 'SPLIT' }],
    )
    expect(got.filter((o) => o.id.toLowerCase() === 'split')).toEqual([{ id: 'split', label: 'Split-Payment' }])
    expect(got.map((o) => o.id)).toEqual(['qris', 'cash', 'split'])
  })
})
