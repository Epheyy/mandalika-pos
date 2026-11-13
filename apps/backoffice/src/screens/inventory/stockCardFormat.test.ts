import { describe, expect, it } from 'vitest'
import {
  formatMovementTime, KIND_GROUPS, MOVEMENT_KIND_LABEL, movementKindTone, signedQty, skuSearchStart,
} from './stockCardFormat'

describe('formatMovementTime', () => {
  it('reads "04 Nov 2026 · 14:22" in the location zone', () => {
    expect(formatMovementTime('2026-11-04T07:22:00Z', 'Asia/Jakarta')).toBe('04 Nov 2026 · 14:22')
  })
  it('spells August Agt like the rest of the app', () => {
    expect(formatMovementTime('2026-08-15T03:00:00Z', 'Asia/Jakarta')).toBe('15 Agt 2026 · 10:00')
  })
  it('uses 24-hour midnight, not 24:00', () => {
    expect(formatMovementTime('2026-11-04T17:05:00Z', 'Asia/Jakarta')).toBe('05 Nov 2026 · 00:05')
  })
})

describe('signedQty', () => {
  it('signs by direction with a true minus', () => {
    expect(signedQty(9)).toBe('+9')
    expect(signedQty(-1)).toBe('−1')
    expect(signedQty(0)).toBe('')
  })
})

describe('movementKindTone', () => {
  it('greens only the stock-adding kinds', () => {
    expect(movementKindTone('transfer_in')).toBe('ok')
    expect(movementKindTone('sale')).toBe('neutral')
  })
})

describe('skuSearchStart', () => {
  it('drops old results and shows loading with nothing highlighted when a new query starts', () => {
    expect(skuSearchStart<{ id: string }>()).toEqual({ results: [], status: 'loading', active: -1 })
  })
})

describe('void kind', () => {
  it('reads Pembatalan and sits in the refund (kembali) bucket', () => {
    expect(MOVEMENT_KIND_LABEL.void).toBe('Pembatalan')
    expect(KIND_GROUPS.find((g) => g.bucket === 'refund')?.kinds).toContain('void')
  })
})
