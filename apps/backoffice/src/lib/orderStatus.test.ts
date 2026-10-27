import { describe, expect, it } from 'vitest'
import { canRefundWholeOrder, orderStatusLabel, orderStatusTone } from './orderStatus'

describe('orderStatus helpers (C4a)', () => {
  it.each([
    ['completed', 'Selesai', 'success'],
    ['partially_refunded', 'Sebagian refund', 'warning'],
    ['refunded', 'Refund', 'danger'],
    ['cancelled', 'Dibatalkan', 'neutral'],
    ['mystery', 'mystery', 'neutral'],
  ])('%s -> %s / %s', (status, label, tone) => {
    expect(orderStatusLabel(status)).toBe(label)
    expect(orderStatusTone(status)).toBe(tone)
  })

  it('offers the whole-order refund only on a completed order', () => {
    expect(canRefundWholeOrder('completed')).toBe(true)
    expect(canRefundWholeOrder('partially_refunded')).toBe(false)
    expect(canRefundWholeOrder('refunded')).toBe(false)
  })
})
