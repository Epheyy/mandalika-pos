import { describe, expect, it } from 'vitest'
import { OTA_BLOCK_COPY, otaBlockReason, otaCanApply, otaGate, type OtaGateInput } from './otaApplyGate'

const idle: OtaGateInput = { cartCount: 0, isCheckoutOpen: false, isProcessing: false, isSuccessOpen: false, refundActive: false, writesInFlight: false }

describe('OTA apply gate (C5)', () => {
  it('allows a restart only when nothing is in flight', () => {
    expect(otaBlockReason(idle)).toBeNull()
    expect(otaCanApply(idle)).toBe(true)
  })
  it.each([
    ['cart has items', { cartCount: 1 }, 'cart'],
    ['checkout is open', { isCheckoutOpen: true }, 'checkout'],
    ['the success screen is open', { isSuccessOpen: true }, 'checkout'],
    ['an order is being committed', { isProcessing: true }, 'saving'],
    ['an outbox write is in flight', { writesInFlight: true }, 'saving'],
    ['a refund dialog is open or writing', { refundActive: true }, 'refund'],
  ] as const)('blocks when %s', (_n, over, reason) => {
    expect(otaBlockReason({ ...idle, ...over })).toBe(reason)
    expect(otaCanApply({ ...idle, ...over })).toBe(false)
  })
  it('reports the most urgent reason first', () => {
    expect(otaBlockReason({ ...idle, cartCount: 2, isCheckoutOpen: true, writesInFlight: true })).toBe('saving')
    expect(otaBlockReason({ ...idle, cartCount: 2, isCheckoutOpen: true })).toBe('checkout')
    expect(otaBlockReason({ ...idle, cartCount: 2, refundActive: true })).toBe('refund')
  })
  it('has copy for every reason', () => {
    for (const r of ['saving', 'checkout', 'refund', 'cart'] as const) expect(OTA_BLOCK_COPY[r].length).toBeGreaterThan(0)
  })
})

describe('tap-time gate (C5)', () => {
  const { writesInFlight: _w, ...base } = idle
  const gate = (busy: boolean) => ({ current: { isBusy: () => busy } })
  it('is idle when no single-flight gate is busy', () => {
    expect(otaBlockReason(otaGate(base, false, [gate(false), gate(false)]))).toBeNull()
  })
  it('blocks when any live gate (sale, refund, customer, receive) is busy', () => {
    expect(otaBlockReason(otaGate(base, false, [gate(false), gate(true)]))).toBe('saving')
  })
  it('blocks while a customer is being saved even if no gate ref is busy', () => {
    expect(otaBlockReason(otaGate(base, true, [gate(false)]))).toBe('saving')
  })
  it('reads the refs at call time, not at construction', () => {
    const g = { current: { isBusy: () => false } }
    const read = () => otaGate(base, false, [g])
    expect(otaBlockReason(read())).toBeNull()
    g.current = { isBusy: () => true }
    expect(otaBlockReason(read())).toBe('saving')
  })
})
