import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { OrderHistoryPanel } from './OrderHistoryPanel'
import { historyWindowFor } from './orderHistoryQuery'

const props = {
  isOpen: true, onClose: vi.fn(), onRefund: vi.fn(), onReprint: vi.fn(), canReprint: true, canRefund: true, hasOpenShift: true,
  queuedRefundOrderIds: new Set<string>(),
}

describe('OrderHistoryPanel opened on one sale (refund from Riwayat)', () => {
  it('starts on the sale number and the days around its capture', () => {
    const html = renderToStaticMarkup(createElement(OrderHistoryPanel, { ...props, timezone: 'Asia/Jakarta', focus: { orderId: 'srv-1', orderNumber: 'BSD-G0007', capturedAt: '2026-10-20T03:00:00Z' } }))
    expect(html).toContain('value="BSD-G0007"')
    expect(html).toContain('value="2026-10-19"')
    expect(html).toContain('value="2026-10-21"')
  })

  it('without a focus the search starts empty', () => {
    expect(renderToStaticMarkup(createElement(OrderHistoryPanel, { ...props }))).not.toContain('value="BSD-G0007"')
  })

  it('CashierScreen re-keys the panel by the focus and clears it for the plain Riwayat button', () => {
    const src = readFileSync(new URL('./CashierScreen.tsx', import.meta.url), 'utf8')
    expect(src).toContain("key={historyFocus ? `focus:${historyFocus.orderId}` : 'plain'}")
    expect(src).toContain('onHistory={() => { setHistoryFocus(null); setShowHistory(true) }}')
    expect(src).toContain('onOpenInHistory=')
  })
})

describe('historyWindowFor', () => {
  const now = new Date('2026-10-28T09:00:00Z')
  it('opens on the sale day with one day either side, never past today', () => {
    expect(historyWindowFor('2026-10-20T03:00:00Z', now)).toEqual({ from: '2026-10-19', to: '2026-10-21' })
    expect(historyWindowFor('2026-10-28T02:00:00Z', now)).toEqual({ from: '2026-10-27', to: '2026-10-28' })
  })
  it('uses the outlet day, not the UTC day (a sale after local midnight)', () => {
    // 2026-10-20 18:00Z is 2026-10-21 01:00 in Asia/Jakarta (UTC+7).
    expect(historyWindowFor('2026-10-20T18:00:00Z', now, 'Asia/Jakarta')).toEqual({ from: '2026-10-20', to: '2026-10-22' })
  })
  it('falls back to today for an unreadable time', () => {
    expect(historyWindowFor('nope', now)).toEqual({ from: '2026-10-28', to: '2026-10-28' })
  })
})
