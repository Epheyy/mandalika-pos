import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CustomerChip } from './CustomerChip'
import { rewardChipText } from './customerProfile'

const gold = { id: 'a', name: 'Rina', phone: '0812', points: 70, totalSpent: 2_500_000, visitCount: 4, createdAt: '2026-01-01T00:00:00Z' }
const chip = (over: Partial<Parameters<typeof CustomerChip>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(CustomerChip, {
      customer: gold, loyaltyEnabled: true, rewards: { kind: 'count', n: 2 }, onOpenProfile: vi.fn(), onOpenPicker: vi.fn(), onRelease: vi.fn(), ...over,
    }),
  )

describe('CustomerChip', () => {
  it('offers + Pelanggan when empty', () => {
    const html = chip({ customer: null })
    expect(html).toContain('+ Pelanggan')
    expect(html).not.toContain('Lepas')
  })

  it('shows name, tier, points, the reward count and Ganti / Lepas', () => {
    const html = chip()
    expect(html).toContain('Rina')
    expect(html).toContain('Gold')
    expect(html).toContain('70 poin')
    expect(html).toContain('2 hadiah tersedia · pilih di Bayar')
    expect(html).toContain('Ganti')
    expect(html).toContain('Lepas')
  })

  it('makes the name a profile button only when the brand has the profile', () => {
    expect(chip()).toContain('aria-label="Profil Rina"')
    expect(chip({ onOpenProfile: null })).not.toContain('aria-label="Profil Rina"')
  })

  it('hides the tier for a customer with no known spend and everything loyalty when it is off', () => {
    expect(chip({ customer: { ...gold, totalSpent: 0, visitCount: 0 } })).not.toContain('Gold')
    const off = chip({ loyaltyEnabled: false, rewards: { kind: 'hidden' } })
    expect(off).not.toContain('poin')
    expect(off).not.toContain('hadiah')
  })

  it('shows the provisional earned points only with loyalty on', () => {
    expect(chip({ earnedPoints: 12 })).toContain('+12 poin (tampilan sementara)')
    expect(chip({ earnedPoints: 0 })).not.toContain('tampilan sementara')
    expect(chip({ earnedPoints: 12, loyaltyEnabled: false, rewards: { kind: 'hidden' } })).not.toContain('tampilan sementara')
  })

  it('words the reward states', () => {
    expect(rewardChipText({ kind: 'offline' })).toBe('Hadiah: Butuh internet')
    expect(rewardChipText({ kind: 'loading' })).toBe('Memeriksa hadiah…')
    expect(rewardChipText({ kind: 'count', n: 0 })).toBe('Belum ada hadiah')
    expect(rewardChipText({ kind: 'hidden' })).toBeNull()
  })
})
