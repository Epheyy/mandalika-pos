import { describe, expect, it } from 'vitest'
import { cancelCountConfirm, completeCountConfirm, lineDifference, startCountConfirm, summarizeCount } from './countConfirm'

const line = (frozenQty: number, actualQty?: number | null, extra: { baselineQty?: number; difference?: number } = {}) => ({
  frozenQty,
  actualQty,
  ...extra,
})

describe('lineDifference', () => {
  it('prefers the stored difference, else counted minus baseline, else counted minus frozen', () => {
    expect(lineDifference(line(10, 7, { difference: -2 }))).toBe(-2)
    expect(lineDifference(line(10, 7, { baselineQty: 9 }))).toBe(-2)
    expect(lineDifference(line(10, 12))).toBe(2)
    expect(lineDifference(line(10, null))).toBeNull()
  })
})

describe('summarizeCount', () => {
  it('counts only counted lines and sums their differences', () => {
    const s = summarizeCount([line(10, 7), line(5, 8), line(4, null), line(3)])
    expect(s).toEqual({ counted: 2, uncounted: 2, net: 0 })
    expect(summarizeCount([line(10, 7), line(5, 6)]).net).toBe(-2)
  })
})

describe('completeCountConfirm', () => {
  it('states the signed net, the counted lines and the uncounted ones', () => {
    const c = completeCountConfirm('Opname Mei', { counted: 3, uncounted: 2, net: -5 })
    expect(c.title).toBe('Selesaikan opname Opname Mei?')
    expect(c.consequence).toContain('-5')
    expect(c.consequence).toContain('berkurang')
    expect(c.consequence).toContain('3 baris yang dihitung')
    expect(c.consequence).toContain('2 baris yang belum dihitung tidak diubah')
  })
  it('says so when nothing is counted or nothing differs', () => {
    expect(completeCountConfirm('X', { counted: 0, uncounted: 4, net: 0 }).consequence).toContain('stok tidak berubah')
    expect(completeCountConfirm('X', { counted: 2, uncounted: 0, net: 0 }).consequence).toContain('Tidak ada selisih bersih')
    expect(completeCountConfirm('X', { counted: 2, uncounted: 0, net: 3 }).consequence).toContain('+3')
  })
})

describe('start and cancel copy', () => {
  it('start changes no stock, cancel is a danger action with its own back word', () => {
    expect(startCountConfirm('X').consequence).toContain('Stok tidak berubah')
    const running = cancelCountConfirm('X', 'in_progress')
    expect(running.tone).toBe('danger')
    expect(running.consequence).toContain('dibuang')
    expect(running.cancelLabel).toBe('Kembali')
    expect(cancelCountConfirm('X', 'planned').consequence).not.toContain('dibuang')
  })
})
