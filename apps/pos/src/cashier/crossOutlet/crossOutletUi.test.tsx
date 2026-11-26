import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { CrossOutletSearch } from './CrossOutletSearch'
import { isCrossOutletOrder } from './useCrossOutletRefund'
import { OrderHistoryPanel } from '../OrderHistoryPanel'
import { RefundDialog } from '../RefundDialog'

type Order = components['schemas']['Order']

const order = {
  id: 'o1', orderNumber: 'LWB-9', outletId: 'x', status: 'completed', paymentMethod: 'cash', total: 100000, subtotal: 100000,
  discountAmount: 0, taxAmount: 0, createdAt: '2026-11-26T03:00:00Z',
  items: [{ lineNo: 0, productId: 'p1', productName: 'Parfum A', variantSize: '', quantity: 1, subtotal: 100000, netAmount: 100000 }],
} as unknown as Order

describe('CrossOutletSearch', () => {
  it('offline: the search input is disabled and says Butuh internet', () => {
    const html = renderToStaticMarkup(createElement(CrossOutletSearch, { isOnline: false, canRefund: true, onRefund: vi.fn() }))
    expect(html).toMatch(/<input[^>]* disabled=/)
    expect(html).toContain('Butuh internet')
    expect(html).toContain('No. order atau nomor HP')
  })
  it('online: the input is enabled', () => {
    const html = renderToStaticMarkup(createElement(CrossOutletSearch, { isOnline: true, canRefund: true, onRefund: vi.fn() }))
    expect(html).not.toMatch(/<input[^>]* disabled=/)
  })
})

describe('OrderHistoryPanel scope switch', () => {
  const props = {
    isOpen: true, onClose: vi.fn(), onRefund: vi.fn(), onReprint: vi.fn(), canReprint: true, canRefund: true, hasOpenShift: true,
    queuedRefundOrderIds: new Set<string>(),
  }
  it('offers "Outlet ini" / "Outlet lain" only when cross-outlet refunds are wired', () => {
    const on = renderToStaticMarkup(createElement(OrderHistoryPanel, { ...props, isOnline: false, onRefundCrossOutlet: vi.fn() }))
    expect(on).toContain('Outlet ini')
    expect(on).toContain('Outlet lain')
    expect(renderToStaticMarkup(createElement(OrderHistoryPanel, { ...props }))).not.toContain('Outlet lain')
  })
})

describe('RefundDialog for a sale at another outlet', () => {
  const info = { originName: 'Lewiliang', pending: false, onResend: vi.fn(), onCheck: vi.fn() }
  it('explains where the sale was made and relabels the confirm', () => {
    const html = renderToStaticMarkup(createElement(RefundDialog, { order, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn(), crossOutlet: info }))
    expect(html).toContain('Penjualan di outlet Lewiliang. Refund dibayar dari shift outlet ini.')
    expect(html).toContain('Kirim refund (butuh internet)')
  })
  it('while sending, tells the cashier not to pay yet', () => {
    const html = renderToStaticMarkup(createElement(RefundDialog, { order, isProcessing: true, onConfirm: vi.fn(), onClose: vi.fn(), crossOutlet: info }))
    expect(html).toContain('Mengirim ke server, jangan bayar dulu')
  })
  it('a pending attempt offers resend and check', () => {
    const html = renderToStaticMarkup(createElement(RefundDialog, { order, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn(), crossOutlet: { ...info, pending: true } }))
    expect(html).toContain('Kirim ulang refund sebelumnya')
    expect(html).toContain('Cek transaksi')
  })
  it('a normal refund is unchanged', () => {
    const html = renderToStaticMarkup(createElement(RefundDialog, { order, isProcessing: false, onConfirm: vi.fn(), onClose: vi.fn() }))
    expect(html).not.toContain('Penjualan di outlet')
    expect(html).not.toContain('Kirim refund')
  })
})

describe('isCrossOutletOrder', () => {
  it('is true only for a known, different outlet', () => {
    expect(isCrossOutletOrder({ outletId: 'x' }, 'y')).toBe(true)
    expect(isCrossOutletOrder({ outletId: 'y' }, 'y')).toBe(false)
    expect(isCrossOutletOrder({ outletId: '' }, 'y')).toBe(false) // local receipts: always the same outlet
    expect(isCrossOutletOrder({ outletId: 'x' }, null)).toBe(false)
    expect(isCrossOutletOrder(null, 'y')).toBe(false)
  })
})

describe('CashierScreen wiring', () => {
  const src = readFileSync(new URL('../CashierScreen.tsx', import.meta.url), 'utf8')
  it('keeps the same-outlet refund on the outbox and sends only cross-outlet orders to the server', () => {
    expect(src).toContain("engine.enqueue('refund', { ...plan.payload })")
    const cross = src.indexOf('await crossRefund.submit(')
    const enqueue = src.indexOf("engine.enqueue('refund'")
    expect(cross).toBeGreaterThan(0)
    expect(cross).toBeLessThan(enqueue) // the cross branch returns before the outbox call
    expect(src).toContain('isCrossOutletOrder(refundOrder, authStore.outletId)')
  })
})
