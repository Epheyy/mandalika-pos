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

describe('RefundDialog long product names', () => {
  const longName = 'GORGEOUS TUBEROSE 110ml EXTRAIT DE PARFUM INTENSE'
  const long = { ...order, items: [{ ...(order.items[0] as object), productName: longName }] } as unknown as Order
  const html = renderToStaticMarkup(createElement(RefundDialog, { order: long, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn() }))
  it('keeps the full name in the title and wraps to at most two lines', () => {
    expect(html).toContain(`title="${longName}`)
    expect(html).toContain('line-clamp-2')
    expect(html).not.toMatch(/text-ink-900 truncate/)
  })
})

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
