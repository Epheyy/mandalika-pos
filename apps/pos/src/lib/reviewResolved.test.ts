import { describe, expect, it } from 'vitest'
import { reviewResolvedMessage } from './reviewResolved'

describe('reviewResolvedMessage', () => {
  it('names the count and the first note', () => {
    expect(reviewResolvedMessage([{ note: 'refund manual' }])).toBe('1 item diselesaikan oleh kantor pusat: refund manual')
    expect(reviewResolvedMessage([{ note: 'a' }, { note: 'b' }])).toBe('2 item diselesaikan oleh kantor pusat: a')
  })
})
