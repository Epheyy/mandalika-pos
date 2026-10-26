import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import { LocalReceiptsPanel } from './LocalReceiptsPanel'

const snapshot = { v: 1, refVersion: 1, subtotal: 100000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 100000, amountPaid: 100000, change: 0, lines: [] }
const row = (over: Partial<LocalReceipt> = {}): LocalReceipt => ({
  orderUuid: 'u-1', idempotencyKey: 'dev:u-1', orderNumber: 'BSD-G0007', capturedAt: '2026-10-20T03:00:00.000Z', outletId: 'out1', shiftId: 's1',
  paymentMethod: 'cash', quotedTotal: 100000, receiptSnapshot: snapshot, state: 'queued', refundQueued: false, refunded: false, ...over,
})
const gate = { canRefund: true, hasOpenShift: true, queuedRefundOrderIds: new Set<string>() }
const render = (receipts: LocalReceipt[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(LocalReceiptsPanel, { isOpen: true, onClose: vi.fn(), receipts, canReprint: true, onReprint: vi.fn(), onRefund: vi.fn(), ...gate, ...over }))

describe('LocalReceiptsPanel', () => {
  it('renders nothing when closed', () => {
    expect(render([row()], { isOpen: false })).toBe('')
  })

  it('lists a queued sale with its badge, reprint and refund buttons', () => {
    const html = render([row()])
    expect(html).toContain('Struk di tablet ini')
    expect(html).toContain('BSD-G0007')
    expect(html).toContain('Tersimpan di tablet')
    expect(html).toContain('Cetak Ulang')
    expect(html).toContain('Refund Transaksi Ini')
  })

  it('shows the muted reason instead of the refund button when the gate blocks it', () => {
    expect(render([row({ refundQueued: true })], { queuedSaleUuids: new Set(['u-1']) })).toContain('Refund tersimpan di tablet')
    expect(render([row({ state: 'synced', refunded: true })], { syncedRefundOrderIds: new Set(['u-1']) })).toContain('Sudah direfund')
    expect(render([row()], { canRefund: false })).toContain('Butuh izin refund')
    expect(render([row()], { hasOpenShift: false })).toContain('Buka shift dulu')
  })

  it('disables reprint without a printer or without a printable snapshot', () => {
    expect(render([row()], { canReprint: false })).toMatch(/disabled=""[^>]*>Cetak Ulang/)
    expect(render([row({ receiptSnapshot: null })])).toMatch(/disabled=""[^>]*>Cetak Ulang/)
  })

  it('shows an empty state and never any customer data', () => {
    expect(render([])).toContain('Belum ada struk di tablet ini')
    expect(render([row()])).not.toMatch(/pelanggan|customer|telepon|phone/i)
  })
})
