import { describe, expect, it } from 'vitest'
import { paymentFilterOptions, retiredMethodLabel } from './paymentOptions'

describe('paymentFilterOptions', () => {
  it('lists configured methods, the legacy cash id and unseen order methods once each', () => {
    const got = paymentFilterOptions(
      [{ id: 'tunai', label: 'Tunai' }, { id: 'qris', label: 'QRIS' }],
      [{ paymentMethod: 'QRIS' }, { paymentMethod: 'bca' }, { paymentMethod: 'cash' }],
    )
    expect(got.map((o) => o.id)).toEqual(['tunai', 'qris', 'cash', 'bca', 'split'])
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai (data lama)')
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
  it('labels the legacy cash id "Tunai (data lama)" when another cash method is configured (F07)', () => {
    const got = paymentFilterOptions([{ id: 'tunai', label: 'TUNAI' }, { id: 'qris', label: 'QRIS' }])
    expect(got.find((o) => o.id === 'tunai')?.label).toBe('TUNAI')
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai (data lama)')
  })
  it('keeps the plain "Tunai" label when no other cash method exists, and honours isCash=false', () => {
    expect(paymentFilterOptions([{ id: 'qris', label: 'QRIS' }]).find((o) => o.id === 'cash')?.label).toBe('Tunai')
    const got = paymentFilterOptions([{ id: 'tunai', label: 'TUNAI', isCash: false }])
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai')
  })
  it('adds historical ids from the server once, case-insensitively, without split (F06)', () => {
    const got = paymentFilterOptions([{ id: 'qris', label: 'QRIS' }], [], ['gopay', 'QRIS', 'split', 'cash'])
    expect(got.map((o) => o.id)).toEqual(['qris', 'cash', 'gopay', 'split'])
  })
  it('labels retired ids readably with (nonaktif) and keeps the stored id', () => {
    const got = paymentFilterOptions([{ id: 'neobank', label: 'NEOBANK' }], [{ paymentMethod: 'mandiri' }], ['neo_bank'])
    expect(got.find((o) => o.id === 'mandiri')?.label).toBe('MANDIRI (nonaktif)')
    expect(got.find((o) => o.id === 'neo_bank')?.label).toBe('NEO BANK (nonaktif)')
    expect(got.find((o) => o.id === 'neobank')?.label).toBe('NEOBANK')
    expect(got.find((o) => o.id === 'cash')?.label).toBe('Tunai')
  })
  it('retiredMethodLabel uppercases and spaces underscores', () => {
    expect(retiredMethodLabel(' gopay_qr ')).toBe('GOPAY QR (nonaktif)')
  })
  it('keeps raw ids (no "nonaktif") while the settings list is not loaded', () => {
    const got = paymentFilterOptions(undefined, [{ paymentMethod: 'qris' }], ['gopay'])
    expect(got.find((o) => o.id === 'qris')?.label).toBe('qris')
    expect(got.find((o) => o.id === 'gopay')?.label).toBe('gopay')
  })
})
