import { describe, expect, it } from 'vitest'
import { PAYMENT_LABELS, paymentLabel } from './paymentLabels'

describe('paymentLabels', () => {
  it('maps the four payment codes to their Indonesian labels', () => {
    expect(PAYMENT_LABELS).toEqual({ cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS' })
  })

  it('returns the label for a known code', () => {
    expect(paymentLabel('qris')).toBe('QRIS')
  })

  it('falls back to the raw code for an unknown method', () => {
    expect(paymentLabel('voucher')).toBe('voucher')
  })
})
