import { describe, expect, it } from 'vitest'
import { orderStateFor } from './orderState'

const rows = [
  { orderUuid: 'a', state: 'synced' as const },
  { orderUuid: 'b', state: 'queued' as const },
  { orderUuid: 'c', state: 'parked' as const },
]

describe('orderStateFor', () => {
  it('maps each state by order uuid', () => {
    expect(orderStateFor(rows, 'a')).toBe('synced')
    expect(orderStateFor(rows, 'b')).toBe('queued')
    expect(orderStateFor(rows, 'c')).toBe('parked')
  })
  it('is unknown without an id or a match', () => {
    expect(orderStateFor(rows, null)).toBe('unknown')
    expect(orderStateFor(rows, 'zzz')).toBe('unknown')
    expect(orderStateFor([], 'a')).toBe('unknown')
  })
})
