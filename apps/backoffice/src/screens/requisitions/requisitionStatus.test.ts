import { describe, expect, it } from 'vitest'
import { canRefulfil, chainIndex } from './requisitionStatus'

describe('requisitionStatus', () => {
  it('places each happy-path status on the chain and dead ends off it', () => {
    expect(['draft', 'submitted', 'approved', 'fulfilled'].map((s) => chainIndex(s as never))).toEqual([0, 1, 2, 3])
    expect(chainIndex('rejected')).toBe(-1)
    expect(chainIndex('cancelled')).toBe(-1)
  })

  it('allows a new transfer only when the linked one was cancelled', () => {
    const link = (status: string) => ({ id: 't', transferNo: 'TRF-1', status })
    expect(canRefulfil({ status: 'fulfilled', transfer: link('cancelled') })).toBe(true)
    expect(canRefulfil({ status: 'fulfilled', transfer: link('draft') })).toBe(false)
    expect(canRefulfil({ status: 'fulfilled', transfer: link('completed') })).toBe(false)
    expect(canRefulfil({ status: 'approved', transfer: undefined })).toBe(false)
  })
})
