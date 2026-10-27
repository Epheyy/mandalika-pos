import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QueueGuardLine } from './QueueGuardLine'

const render = (p: Parameters<typeof QueueGuardLine>[0]) => renderToStaticMarkup(createElement(QueueGuardLine, p))

describe('QueueGuardLine (C2 P13)', () => {
  it('shows the live counts and the reason', () => {
    const html = render({ pending: 2, parked: 1, reason: 'Tunggu sampai terkirim' })
    expect(html).toContain('2 transaksi tersimpan di tablet, 1 perlu ditinjau')
    expect(html).toContain('Tunggu sampai terkirim')
  })
  it('has no reason line when nothing blocks', () => {
    const html = render({ pending: 0, parked: 0 })
    expect(html).toContain('Semua transaksi sudah terkirim')
    expect(html).not.toContain('role="status"')
  })
})
