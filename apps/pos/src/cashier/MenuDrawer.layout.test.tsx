import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'

vi.mock('../brand', () => ({ hasFeature: () => true }))

import { MenuDrawer } from './MenuDrawer'

const noop = () => {}
const render = (over: Partial<React.ComponentProps<typeof MenuDrawer>> = {}) =>
  renderToStaticMarkup(
    createElement(MenuDrawer, {
      open: true,
      onClose: noop,
      user: { displayName: 'Reffy', role: 'cashier' } as components['schemas']['User'],
      shiftActive: true,
      pendingSync: false,
      isSyncing: false,
      heldCount: 0,
      onHeldOrders: noop,
      onHistory: noop,
      onLocalReceipts: noop,
      onRecap: noop,
      onCashFlow: noop,
      onSync: noop,
      onPrintSettings: noop,
      onProductDisplay: noop,
      onBackOffice: noop,
      onTerminal: noop,
      onReceiveTransfer: noop,
      onOpenTransferHistory: noop,
      canRequestStock: false,
      onRequisitions: noop,
      inboundCount: 0,
      ...over,
    } as React.ComponentProps<typeof MenuDrawer>),
  )

describe('MenuDrawer Kaca layout (W7)', () => {
  it('shows count tags for held orders and inbound transfers', () => {
    const out = render({ heldCount: 2, inboundCount: 1 })
    expect(out).toContain('Pesanan tersimpan')
    expect(out).toMatch(/>2<\/span>/)
    expect(out).toContain('1 dikirim')
  })

  it('shows no count tags when there is nothing held or inbound', () => {
    const out = render()
    expect(out).not.toContain('dikirim')
    expect(out).not.toContain('Baru')
  })

  it('identity header: Name · Role, outlet · shift line, and the Back Office row with the external mark', () => {
    const out = render({ outletName: 'Mandalika BSD' })
    expect(out).toContain('Reffy')
    expect(out).toContain('Mandalika BSD · ')
    expect(out).toContain('Shift Aktif')
    expect(out).toContain('Buka Back Office')
  })

  it('keeps every entry in the body so the menu fits the A9 (Perbarui data is the last Operasional row)', () => {
    const out = render()
    for (const label of ['Riwayat', 'Rekap Shift', 'Kas Masuk/Keluar', 'Terima Transfer', 'Riwayat Transfer', 'Perbarui data', 'Pengaturan Cetakan', 'Terminal']) {
      expect(out).toContain(label)
    }
  })
})
