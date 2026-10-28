import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalReceipt } from '@mandalika/sync'
import { LocalReceiptsPanel } from './LocalReceiptsPanel'

// C4b: a synced receipt without per-line data cannot tell what is left to refund (another tablet or the backoffice may
// have part-refunded it), so its refund goes through Riwayat, which reads the server order.

const snapshot = { v: 2, refVersion: 1, subtotal: 100000, discountAmount: 0, surchargeAmount: 0, taxAmount: 0, redeemAmount: 0, total: 100000, amountPaid: 100000, change: 0, lines: [{ productId: 'p', variantSize: '', name: 'A', qty: 1, unitPrice: 100000, amount: 100000 }] }
const row = (over: Partial<LocalReceipt> = {}): LocalReceipt => ({
  orderUuid: 'u-1', idempotencyKey: 'dev:u-1', orderNumber: 'BSD-G0007', capturedAt: '2026-10-20T03:00:00.000Z', outletId: 'out1', shiftId: 's1',
  paymentMethod: 'cash', quotedTotal: 100000, receiptSnapshot: snapshot, state: 'queued', refundQueued: false, refunded: false, ...over,
})
const synced = (over: Partial<LocalReceipt> = {}) => row({ state: 'synced', serverOrderId: 'srv-1', ...over })
const gate = { canRefund: true, hasOpenShift: true, queuedRefundOrderIds: new Set<string>() }
const render = (receipts: LocalReceipt[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(LocalReceiptsPanel, { isOpen: true, onClose: vi.fn(), receipts, canReprint: true, onReprint: vi.fn(), onRefund: vi.fn(), onOpenInHistory: vi.fn(), ...gate, ...over }))

describe('a synced receipt without line data is refunded from Riwayat', () => {
  it('online: no whole-order button, a "Refund lewat Riwayat" button instead', () => {
    const html = render([synced()], { isOnline: true })
    expect(html).toContain('Refund lewat Riwayat')
    expect(html).not.toContain('Refund Transaksi Ini')
  })

  it('offline: the plain message and NO refund button at all', () => {
    const html = render([synced()], { isOnline: false })
    expect(html).toContain('Refund struk ini lewat Riwayat saat online.')
    expect(html).not.toContain('Refund Transaksi Ini')
    expect(html).not.toMatch(/<button[^>]*>\s*Refund/)
  })

  it('an unsynced sale keeps the normal refund button, online or offline', () => {
    for (const isOnline of [true, false]) {
      const html = render([row()], { isOnline })
      expect(html).toContain('Refund Transaksi Ini')
      expect(html).not.toContain('Riwayat saat online')
    }
  })

  it('a synced receipt WITH line data refunds per line from here, even offline', () => {
    const html = render([synced({ lineNets: [100000], lineGroups: [null] })], { isOnline: false })
    expect(html).toContain('Refund Transaksi Ini')
    expect(html).not.toContain('Riwayat saat online')
  })

  it('the existing blocks still win (already refunded, no permission, no shift, queued)', () => {
    expect(render([synced({ refunded: true })], { syncedRefundOrderIds: new Set(['u-1']) })).toContain('Sudah direfund')
    expect(render([synced()], { canRefund: false })).toContain('Butuh izin refund')
    expect(render([synced()], { hasOpenShift: false })).toContain('Buka shift dulu')
    expect(render([synced({ refundQueued: true })], { queuedSaleUuids: new Set(['u-1']) })).toContain('Refund tersimpan di tablet')
  })

  it('a receipt this tablet already part-refunded still goes to Riwayat rather than a dead-end block', () => {
    const html = render([synced()], { refundCache: () => ({ qtyByLine: new Map([[0, 1]]), amount: 50000 }) })
    expect(html).toContain('Refund lewat Riwayat')
    expect(html).not.toContain('Refund Transaksi Ini')
  })

  it('without an open-in-Riwayat handler the old behaviour is unchanged', () => {
    expect(render([synced()], { onOpenInHistory: undefined })).toContain('Refund Transaksi Ini')
  })
})

describe('a partly refunded receipt without line data keeps the plain gates in front of Riwayat', () => {
  const part = { refundCache: () => ({ qtyByLine: new Map([[0, 1]]), amount: 50000 }) }
  it('no refund permission, no shift and a queued refund are shown as such, not as the Riwayat button', () => {
    expect(render([synced()], { ...part, canRefund: false })).toContain('Butuh izin refund')
    expect(render([synced()], { ...part, hasOpenShift: false })).toContain('Buka shift dulu')
    const queued = render([synced({ refundQueued: true })], { ...part, queuedSaleUuids: new Set(['u-1']) })
    expect(queued).toContain('Refund tersimpan di tablet')
    for (const html of [render([synced()], { ...part, canRefund: false }), queued]) expect(html).not.toContain('Refund lewat Riwayat')
  })
})
