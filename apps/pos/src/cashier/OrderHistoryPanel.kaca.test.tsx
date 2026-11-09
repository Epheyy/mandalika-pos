import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OrderHistoryPanel, dateModeOf } from './OrderHistoryPanel'

const props = {
  isOpen: true, onClose: vi.fn(), onRefund: vi.fn(), onReprint: vi.fn(), canReprint: true, canRefund: true, hasOpenShift: true,
  queuedRefundOrderIds: new Set<string>(), timezone: 'Asia/Jakarta',
}

describe('Riwayat date segments (W4-02)', () => {
  it('maps one day to Hari ini / Kemarin and everything else to Pilih tanggal', () => {
    expect(dateModeOf('2026-11-07', '2026-11-07', '2026-11-07')).toBe('today')
    expect(dateModeOf('2026-11-06', '2026-11-06', '2026-11-07')).toBe('yesterday')
    expect(dateModeOf('2026-11-01', '2026-11-07', '2026-11-07')).toBe('custom')
    expect(dateModeOf('2026-10-30', '2026-10-30', '2026-11-07')).toBe('custom')
  })
  it('shows the three segments, and the date boxes only for a custom range', () => {
    const plain = renderToStaticMarkup(createElement(OrderHistoryPanel, props))
    for (const t of ['Hari ini', 'Kemarin', 'Pilih tanggal']) expect(plain).toContain(t)
    expect(plain).not.toContain('history-from')
    const focused = renderToStaticMarkup(createElement(OrderHistoryPanel, { ...props, focus: { orderId: 'x', orderNumber: 'A-1', capturedAt: '2020-01-05T03:00:00Z', nonce: 1 } }))
    expect(focused).toContain('history-from')
  })
})

describe('shift-day explanation (F12)', () => {
  it('labels the chip group and explains shift day vs clock time without a hover title', () => {
    const html = renderToStaticMarkup(createElement(OrderHistoryPanel, props))
    expect(html).toContain('Hari shift')
    expect(html).toContain('history-shift-day-hint')
    expect(html).toContain('bukan jam di struk')
    expect(html).not.toContain('title="Menurut hari bisnis')
  })
})
