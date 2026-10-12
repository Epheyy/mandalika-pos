import { describe, expect, it } from 'vitest'
import { sameItems } from './useOfflineData'

describe('sameItems', () => {
  it('treats a reported flag flip as a change', () => {
    const a = [{ idempotencyKey: 'd:1', type: 'refund', lastError: 'x' }]
    expect(sameItems(a, [{ ...a[0] }])).toBe(true)
    expect(sameItems(a, [{ ...a[0], reported: true }])).toBe(false)
  })
})
