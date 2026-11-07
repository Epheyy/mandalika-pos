import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CustomerProfileSheet } from './CustomerProfileSheet'

const NOW = Date.parse('2026-10-27T12:00:00Z')
const rina = { id: 'c1', name: 'Rina', phone: '081200009999', points: 70, totalSpent: 2_500_000, visitCount: 4, createdAt: '2026-01-01T00:00:00Z' }
const profile = {
  customer: { id: 'c1', name: 'Rina', phone: '081200009999', tier: 'Gold', points: 70, since: '2026-01-01T00:00:00Z', orderCount: 4, totalSpend: 2_500_000 },
  rewardsAvailable: 1,
  lastOrders: [{ id: 'o1', number: 'ORD-1', at: '2026-10-06T12:00:00Z', outletCode: 'AAA', paymentMethod: 'cash', total: 300000, lines: [{ productId: 'p', name: 'Rose', size: '50ml', qty: 3, free: false }] }],
  frequentItems: [{ productId: 'p', size: '50ml', name: 'Rose', count: 6 }],
  notes: [{ at: '2026-02-02', text: 'suka floral', kind: 'catatan' }],
  pitch: { lastItem: 'Rose', lastAt: '2026-10-06T12:00:00Z', usualIntervalDays: 20, neverTriedCategories: ['Woody'] },
}
const render = (over: Partial<Parameters<typeof CustomerProfileSheet>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CustomerProfileSheet, {
      customer: rina, status: 'ready', profile: profile as never, localOrders: [], loyaltyEnabled: true, rewardsCount: null, attached: false, now: NOW,
      onRepeat: vi.fn(), onAddOne: vi.fn(), onSelect: vi.fn(), onClose: vi.fn(), ...over,
    }),
  )

describe('CustomerProfileSheet', () => {
  it('shows the identity, tier, stats, pitch, history, frequent items and notes from the server', () => {
    const html = render()
    for (const t of ['Rina', 'Gold', 'total belanja', 'sejak terakhir', 'Rp 2,5 jt', 'pelanggan sejak', 'Bahan obrolan', 'Terakhir beli Rose', 'Woody belum pernah dicoba', 'Pembelian terakhir', 'Ulangi', 'Sering dibeli', 'suka floral', 'Pilih untuk transaksi ini'])
      expect(html).toContain(t)
    expect(html).not.toContain('Riwayat lengkap butuh internet')
  })

  it('falls back to this tablet receipts and says the full history needs internet', () => {
    const html = render({
      status: 'unavailable', profile: null,
      localOrders: [{ id: 'l1', number: 'ORD-L', at: '2026-10-26T12:00:00Z', paymentMethod: 'cash', total: 100000, lines: [{ productId: 'p', name: 'Oud', size: '10ml', qty: 1, free: false }] }],
    })
    expect(html).toContain('Riwayat lengkap butuh internet')
    expect(html).toContain('Oud')
    expect(html).not.toContain('Bahan obrolan')
    expect(html).not.toContain('total belanja')
    expect(html).not.toContain('Sering dibeli')
  })

  it('disables Ulangi for a sale made only of reward lines', () => {
    const html = render({ profile: { ...profile, lastOrders: [{ ...profile.lastOrders[0], lines: [{ productId: 'p', name: 'Gift', size: '10ml', qty: 1, free: true }] }] } as never })
    expect(html).toMatch(/<button aria-label="Ulangi ORD-1"[^>]*disabled=""/)
  })

  it('turns the gold bar into a close button when the customer is already on the sale', () => {
    expect(render({ attached: true })).toContain('Sudah dipilih')
  })

  it('uses the live reward count when the cart knows it and hides loyalty stats when loyalty is off', () => {
    expect(render({ rewardsCount: 3 })).toContain('3 hadiah')
    expect(render({ loyaltyEnabled: false })).not.toContain('hadiah<')
  })

  it('lists Pembelian terakhir before Sering dibeli, with outlet and method on the second line', () => {
    const html = render()
    expect(html.indexOf('Pembelian terakhir')).toBeLessThan(html.indexOf('Sering dibeli'))
    expect(html).toContain('AAA · Tunai')
  })

  it('tints the hadiah tile only when a reward is available and writes points with a thousands dot', () => {
    expect(render({ rewardsCount: 0 })).not.toContain('bg-reward-bg')
    expect(render({ rewardsCount: 2 })).toContain('bg-reward-bg')
    expect(render({ profile: { ...profile, customer: { ...profile.customer, points: 1250 } } as never })).toContain('1.250')
  })

  it('stays closed without a customer', () => {
    expect(render({ customer: null })).toBe('')
  })
})
