import { readFileSync } from 'node:fs'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReceiptPreview } from '../ReceiptPreview'

type Props = ComponentProps<typeof ReceiptPreview>
const noop = () => {}
const base: Props = {
  isOpen: true, orderId: 'abcdef12-0000', orderNumber: 'BSD-0001', items: [], totalRows: [],
  paymentMethod: 'cash', amountPaid: 150000, change: 50000, customerName: 'Sari', customerPhone: '0812000', cashierName: 'Dewi',
  settings: { receipt: { headerText: '', footerText: '' } } as never, capturedAt: new Date(2026, 10, 27, 10, 0, 0),
  orderState: 'synced', isPendingSync: false, canReprint: false, printError: null, onReprint: noop, onClose: noop, onNewSale: noop,
}

describe('Kirim struk WA entry points', () => {
  it('success view: shows the button only when onSendWa is wired, even with no printer', () => {
    expect(renderToStaticMarkup(createElement(ReceiptPreview, base))).not.toContain('Kirim struk WA')
    expect(renderToStaticMarkup(createElement(ReceiptPreview, { ...base, onSendWa: vi.fn() }))).toContain('Kirim struk WA')
  })

  it('Riwayat: the button is online-only and gated to completed/partially refunded, non-voided server orders', () => {
    const src = readFileSync(new URL('../OrderHistoryPanel.tsx', import.meta.url), 'utf8')
    expect(src).toContain('data-testid="history-send-wa"')
    expect(src).toMatch(/isOnline && \(o\.status === 'completed' \|\| o\.status === 'partially_refunded'\) && !o\.void/)
    expect(src).toContain('allowEmptyPhone={!!waOrder.customerId}')
  })

  it('CashierScreen captures the sale uuid and customer phone when the button is pressed, and wires isOnline/flush', () => {
    const src = readFileSync(new URL('../CashierScreen.tsx', import.meta.url), 'utf8')
    expect(src).toContain('setWaSheet({ orderUuid: state.lastOrderId as string, phone: state.selectedCustomer?.phone ?? \'\' })')
    expect(src).toContain('flush={offlineData.flush}')
  })
})
