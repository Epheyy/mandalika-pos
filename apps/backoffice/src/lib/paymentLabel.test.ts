import { describe, expect, it } from 'vitest'
import { canonicalMethodCode, canonicalMethodLabel, groupPayRows } from './paymentLabel'

describe('canonicalMethodLabel', () => {
  it('maps cash/tunai in any casing to Tunai', () => {
    for (const id of ['cash', 'Cash', 'CASH', 'tunai', 'Tunai']) expect(canonicalMethodLabel(id)).toBe('Tunai')
  })
  it('upper-cases bank acronyms', () => {
    expect(canonicalMethodLabel('bca')).toBe('BCA')
    expect(canonicalMethodLabel('Bri')).toBe('BRI')
    expect(canonicalMethodLabel('qris')).toBe('QRIS')
  })
  it('prefers a configured name over the fixed bank names, except cash', () => {
    expect(canonicalMethodLabel('bca', [{ id: 'bca', label: 'BCA Debit' }])).toBe('BCA Debit')
    expect(canonicalMethodLabel('cash', [{ id: 'cash', label: 'Cash' }])).toBe('Tunai')
  })
  it('uses the configured name for unknown ids, else a title-cased id', () => {
    expect(canonicalMethodLabel('gopay', [{ id: 'GoPay', label: 'Go-Pay' }])).toBe('Go-Pay')
    expect(canonicalMethodLabel('ovo_wallet')).toBe('Ovo Wallet')
  })
})

describe('groupPayRows', () => {
  it('merges "Cash" and "cash" and "tunai" into one Tunai row', () => {
    const rows = groupPayRows([['Cash', 100], ['cash', 50], ['tunai', 25], ['bca', 70]])
    expect(rows).toEqual([
      { method: 'cash', label: 'Tunai', amount: 175 },
      { method: 'bca', label: 'BCA', amount: 70 },
    ])
  })
  it('canonical code folds aliases', () => {
    expect(canonicalMethodCode(' Tunai ')).toBe('cash')
  })
})
