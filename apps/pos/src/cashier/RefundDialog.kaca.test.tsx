import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { RefundDialog } from './RefundDialog'

type Order = components['schemas']['Order']

const order = {
  id: 'o1', orderNumber: 'BSD-00398', status: 'completed', paymentMethod: 'cash', total: 350000, subtotal: 350000,
  discountAmount: 0, taxAmount: 0, createdAt: '2026-11-06T09:42:00Z', cashierName: 'Rina', customerName: 'Budi Santoso',
  items: [
    { lineNo: 0, productId: 'p1', productName: 'Rehearsal Alpha', variantSize: '50 ml', quantity: 1, subtotal: 350000, netAmount: 350000 },
    { lineNo: 1, productId: 'p2', productName: 'Tas Kanvas', variantSize: 'STD', quantity: 1, subtotal: 0, netAmount: 0, isReward: true },
  ],
} as unknown as Order

describe('RefundDialog Kaca header and rows (W4-08, W4-09)', () => {
  const html = renderToStaticMarkup(createElement(RefundDialog, { order, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn() })).replace(/\s/g, ' ')
  it('names the sale with #number, kasir and customer', () => {
    expect(html).toContain('#BSD-00398')
    expect(html).toContain('Kasir Rina')
    expect(html).toContain('Budi Santoso')
  })
  it('shows a quantity column and Gratis for a free line, without the "bisa direfund" note on an untouched line', () => {
    expect(html).toMatch(/1(<!-- -->)? ×/)
    expect(html).toContain('Gratis')
    expect(html).not.toContain('bisa direfund')
  })
})
