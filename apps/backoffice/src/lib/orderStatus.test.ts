import { describe, expect, it } from 'vitest'
import { canRefundWholeOrder, orderIconClasses, orderStatusLabel, orderStatusTone } from './orderStatus'

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

describe('orderIconClasses (C4a)', () => {
  it('tints refunded danger, partially refunded warn, others neutral', () => {
    expect(orderIconClasses('refunded').tile).toBe('bg-danger-bg')
    expect(orderIconClasses('partially_refunded').tile).toBe('bg-warn-bg')
    expect(orderIconClasses('completed').tile).toBe('bg-paper-1')
  })
})
