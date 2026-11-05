import { describe, expect, it } from 'vitest'
import { recapRows, differenceLines } from './recapRows'

const methods = [
  { id: 'cash', label: 'Tunai', isEnabled: true },
  { id: 'qris', label: 'QRIS', isEnabled: false },
  { id: 'card', label: 'Kartu', isEnabled: true },
]

describe('recapRows', () => {
  it('lists enabled methods even with no money, in configured order', () => {
    expect(recapRows(methods, {}).map((r) => r.id)).toEqual(['cash', 'card'])
  })

  it('keeps a disabled method that holds money', () => {
    const rows = recapRows(methods, { cash: 100, qris: 50 })
    expect(rows.map((r) => r.id)).toEqual(['cash', 'qris', 'card'])
    expect(rows.find((r) => r.id === 'qris')?.recorded).toBe(50)
  })

  it('lists an unconfigured key with money, labelled by the payment label helper', () => {
    const rows = recapRows(methods, { cash: 10, transfer: 5, weird: 7 })
    expect(rows.find((r) => r.id === 'transfer')?.label).toBe('Transfer')
    expect(rows.find((r) => r.id === 'weird')?.label).toBe('weird')
  })

  it('skips an unconfigured key that nets to zero', () => {
    expect(recapRows(methods, { weird: 0 }).map((r) => r.id)).toEqual(['cash', 'card'])
  })

  it('rows always sum to the total recorded (the QA 3.075.001 vs 2.475.001 case)', () => {
    const byMethod = { cash: 1_000_000, card: 1_475_001, qris: 400_000, ovo: 200_000 }
    const rows = recapRows(methods, byMethod)
    const total = Object.values(byMethod).reduce((a, b) => a + b, 0)
    expect(total).toBe(3_075_001)
    expect(rows.reduce((s, r) => s + r.recorded, 0)).toBe(total)
  })

  it('includes negative amounts (cash paid out of another method)', () => {
    const rows = recapRows(methods, { cash: -20, qris: 20 })
    expect(rows.reduce((s, r) => s + r.recorded, 0)).toBe(0)
  })
})

describe('differenceLines', () => {
  const rows = recapRows(methods, { cash: 100, card: 50 })
  it('lists only counted rows whose count differs, signed', () => {
    expect(differenceLines(rows, { cash: 90, card: 50 })).toEqual([{ id: 'cash', label: 'Tunai', diff: -10 }])
  })
  it('is empty when everything matches', () => {
    expect(differenceLines(rows, { cash: 100, card: 50 })).toEqual([])
  })
  it('treats an uncounted row as no count (not a difference)', () => {
    expect(differenceLines(rows, { cash: 100 })).toEqual([])
  })
})
