import { describe, expect, it } from 'vitest'
import { PAYMENT_LABELS, SPLIT_LABEL, paymentLabel, tenderLabel } from './paymentLabels'

describe('paymentLabels', () => {
  it('maps the payment codes (and the split sentinel) to their Indonesian labels', () => {
    expect(PAYMENT_LABELS).toEqual({ cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS', split: 'Split-Payment' })
    expect(SPLIT_LABEL).toBe('Split-Payment')
  })

  it('returns the label for a known code', () => {
    expect(paymentLabel('qris')).toBe('QRIS')
    expect(paymentLabel('split')).toBe('Split-Payment')
  })

  it('falls back to the raw code for an unknown method', () => {
    expect(paymentLabel('voucher')).toBe('voucher')
  })
})

describe('tenderLabel', () => {
  const methods = [{ id: 'gopay', label: 'GoPay' }]

  it('prefers the built-in label', () => {
    expect(tenderLabel('cash', [{ id: 'cash', label: 'Kas' }])).toBe('Tunai')
  })

  it('uses the configured label, matching the id case-insensitively', () => {
    expect(tenderLabel('GoPay', methods)).toBe('GoPay')
    expect(tenderLabel('GOPAY', methods)).toBe('GoPay')
  })

  it('falls back to the raw id', () => {
    expect(tenderLabel('voucher', methods)).toBe('voucher')
    expect(tenderLabel('voucher')).toBe('voucher')
  })
})
