import { describe, expect, it } from 'vitest'
import { isCashMethod } from '@mandalika/types'
import { cashTender } from './tender'

describe('cashTender', () => {
  it('treats an empty or blank cash input as the exact total', () => {
    expect(cashTender(true, '', 100000)).toEqual({ amountPaid: 100000, change: 0, isShort: false })
    expect(cashTender(true, '   ', 100000)).toEqual({ amountPaid: 100000, change: 0, isShort: false })
  })
  it('blocks a typed amount below the total, including 0', () => {
    expect(cashTender(true, '90000', 100000)).toEqual({ amountPaid: 90000, change: 0, isShort: true })
    expect(cashTender(true, '0', 100000).isShort).toBe(true)
    expect(cashTender(true, 'abc', 100000).isShort).toBe(true)
  })
  it('gives change at or above the total', () => {
    expect(cashTender(true, '100000', 100000)).toEqual({ amountPaid: 100000, change: 0, isShort: false })
    expect(cashTender(true, '150000', 100000)).toEqual({ amountPaid: 150000, change: 50000, isShort: false })
    expect(cashTender(true, '150.000', 100000).change).toBe(50000)
  })
  it('non-cash is always paid exactly the total, whatever was typed', () => {
    expect(cashTender(false, '', 100000)).toEqual({ amountPaid: 100000, change: 0, isShort: false })
    expect(cashTender(false, '5', 100000)).toEqual({ amountPaid: 100000, change: 0, isShort: false })
  })
  it('handles a zero total', () => {
    expect(cashTender(true, '', 0)).toEqual({ amountPaid: 0, change: 0, isShort: false })
    expect(cashTender(true, '0', 0).isShort).toBe(false)
  })
})

// Mirrors backend IsCashMethod (service/payment_method_test.go).
describe('isCashMethod', () => {
  it('defaults cash and tunai (case-insensitive), also when absent from config', () => {
    expect(isCashMethod([], 'cash')).toBe(true)
    expect(isCashMethod(undefined, ' TUNAI ')).toBe(true)
    expect(isCashMethod([], 'qris')).toBe(false)
    expect(isCashMethod([{ id: 'kas_kecil', isCash: true }], 'cash')).toBe(true)
  })
  it('an explicit flag wins, including false', () => {
    expect(isCashMethod([{ id: 'kas_kecil', isCash: true }], 'KAS_KECIL')).toBe(true)
    expect(isCashMethod([{ id: 'tunai', isCash: false }], 'tunai')).toBe(false)
    expect(isCashMethod([{ id: 'tunai', isCash: null }], 'tunai')).toBe(true)
    expect(isCashMethod([{ id: 'bca' }], 'bca')).toBe(false)
  })
})
