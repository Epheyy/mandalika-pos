import { describe, expect, it } from 'vitest'
import { formatMovementTime, movementKindTone, signedQty } from './stockCardFormat'

describe('formatMovementTime', () => {
  it('reads "04 Nov 2026 · 14:22" in the location zone', () => {
    expect(formatMovementTime('2026-11-04T07:22:00Z', 'Asia/Jakarta')).toBe('04 Nov 2026 · 14:22')
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
