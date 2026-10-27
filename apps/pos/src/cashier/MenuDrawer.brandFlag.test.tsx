import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'

const flags = vi.hoisted(() => ({ requisitions: true }))
vi.mock('../brand', () => ({
  hasFeature: (name: string) => (name === 'requisitions' ? flags.requisitions : true),
}))

import { MenuDrawer } from './MenuDrawer'

const noop = () => {}
const render = (canRequestStock: boolean) =>
  renderToStaticMarkup(
    createElement(MenuDrawer, {
      open: true,
      onClose: noop,
      user: { displayName: 'Kasir' } as components['schemas']['User'],
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
      canRequestStock,
      onRequisitions: noop,
      inboundCount: 0,
    } as React.ComponentProps<typeof MenuDrawer>),
  )

describe('MenuDrawer brand feature flag', () => {
  beforeEach(() => {
    flags.requisitions = true
  })

  it('shows Permintaan Barang when the user may request stock and the brand enables requisitions', () => {
    expect(render(true)).toContain('Permintaan Barang')
  })

  it('hides it when the brand disables requisitions, even for an allowed user', () => {
    flags.requisitions = false
    expect(render(true)).not.toContain('Permintaan Barang')
  })

  it('still hides it for a user without the stock permission', () => {
    expect(render(false)).not.toContain('Permintaan Barang')
  })
})
