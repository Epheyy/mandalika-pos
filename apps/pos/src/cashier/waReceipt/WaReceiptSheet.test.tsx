import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WaReceiptSheet } from './WaReceiptSheet'

const props = {
  open: true, onClose: vi.fn(), target: { orderUuid: 'u1' }, initialPhone: '0812 3456 789', allowEmptyPhone: false,
  isOnline: true, isSynced: true, flush: vi.fn(), api: { createReceiptLink: vi.fn() },
}
const render = (over: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(WaReceiptSheet, { ...props, ...over }))

describe('WaReceiptSheet', () => {
  it('shows the title, a tel input prefilled with the customer phone and Buat pesan', () => {
    const html = render()
    expect(html).toContain('Kirim struk via WhatsApp')
    expect(html).toContain('Nomor WhatsApp')
    expect(html).toMatch(/inputMode="tel"|inputmode="tel"/)
    expect(html).toContain('value="0812 3456 789"')
    expect(html).toContain('Buat pesan')
    expect(html).not.toContain('Buka WhatsApp')
    expect(html).not.toContain('Kosongkan untuk memakai nomor pelanggan')
  })
  it('offline: Butuh internet, input and button disabled, nothing sent', () => {
    const html = render({ isOnline: false })
    expect(html).toContain('Butuh internet')
    expect(html).toMatch(/<input[^>]* disabled=/)
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Buat pesan/)
    expect(props.api.createReceiptLink).not.toHaveBeenCalled()
  })
  it('Riwayat order with a customer: the blank-phone hint', () => {
    expect(render({ allowEmptyPhone: true, initialPhone: '' })).toContain('Kosongkan untuk memakai nomor pelanggan')
  })
  it('closed sheet renders nothing', () => expect(render({ open: false })).toBe(''))
})
