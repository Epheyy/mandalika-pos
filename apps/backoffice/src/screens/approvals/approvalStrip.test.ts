import { describe, expect, it } from 'vitest'
import { adjustmentStrip } from './approvalStrip'

describe('adjustmentStrip', () => {
  it('shows requested, live and applied stock when nothing moved', () => {
    const s = adjustmentStrip({ qtyAtRequest: 10, requestedNewQty: 7, liveQty: 10 })
    expect(s.cells.map((c) => c.title)).toEqual(['Saat diajukan', 'Sekarang', 'Yang diterapkan'])
    expect(s.cells[0]).toMatchObject({ value: '10', note: 'diminta menjadi 7' })
    expect(s.cells[1]).toMatchObject({ value: '10', note: 'tidak berubah sejak diajukan' })
    expect(s.cells[2]).toMatchObject({ value: '-3', note: 'stok menjadi 7' })
    expect(s.drifted).toBe(false)
    expect(s.goesNegative).toBe(false)
  })
  it('applies the difference to live stock, not the requested new quantity', () => {
    const s = adjustmentStrip({ qtyAtRequest: 10, requestedNewQty: 7, liveQty: 6 })
    expect(s.cells[1].note).toBe('-4 sejak diajukan')
    expect(s.cells[2]).toMatchObject({ value: '-3', note: 'stok menjadi 3' })
    expect(s.drifted).toBe(true)
    expect(s.drift).toBe(-4)
    expect(s.delta).toBe(-3)
  })
  it('flags a result below zero', () => {
    const s = adjustmentStrip({ qtyAtRequest: 10, requestedNewQty: 4, liveQty: 2 })
    expect(s.cells[2].note).toBe('stok menjadi -4')
    expect(s.goesNegative).toBe(true)
    expect(s.resultingQty).toBe(-4)
  })
  it('does not claim a result when live stock is unknown', () => {
    const s = adjustmentStrip({ qtyAtRequest: 5, requestedNewQty: 8 })
    expect(s.cells[1]).toMatchObject({ value: '-', note: 'stok sekarang tidak diketahui' })
    expect(s.cells[2]).toMatchObject({ value: '+3', note: 'stok akhir tidak diketahui' })
    expect(s.goesNegative).toBe(false)
    expect(s.drifted).toBe(false)
  })
})
