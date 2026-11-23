import { describe, expect, it } from 'vitest'
import type { ClassicBondedDevice } from './classicTypes'
import { DRAIN_BASE_MS, DRAIN_BYTES_PER_MS, DRAIN_MAX_MS, MAX_RECEIPT_PAYLOAD_BYTES, chooseLink, drainDelayMs, findBonded, toBase64 } from './linkChoice'

const dev = (type: ClassicBondedDevice['type'], hasSpp: boolean): ClassicBondedDevice => ({
  address: '86:67:7A:7E:30:CB',
  name: 'RPPO2N',
  type,
  hasSpp,
})

describe('chooseLink', () => {
  it.each([
    ['dual', true, 'spp'],
    ['classic', false, 'spp'],
    ['le', false, 'ble'],
    ['dual', false, 'ble'],
    ['unknown', false, 'ble'],
  ] as const)('%s hasSpp=%s -> %s', (type, hasSpp, want) => {
    expect(chooseLink(dev(type, hasSpp))).toBe(want)
  })
  it('undefined -> ble', () => expect(chooseLink(undefined)).toBe('ble'))
})

describe('findBonded', () => {
  it('matches case-insensitively', () => {
    const list = [dev('dual', true)]
    expect(findBonded(list, '86:67:7a:7e:30:cb')).toBe(list[0])
  })
  it('returns undefined for an unknown id', () => {
    expect(findBonded([dev('dual', true)], 'AA:BB:CC:DD:EE:FF')).toBeUndefined()
  })
})

describe('drainDelayMs', () => {
  it.each([
    [0, 0],
    [1, 301],
    [800, 700],
    [100000, 50300],
    [10_000_000, 80000],
  ])('%i bytes -> %i ms', (bytes, ms) => expect(drainDelayMs(bytes)).toBe(ms))
})

describe('toBase64', () => {
  it('encodes ESC @', () => expect(toBase64(new Uint8Array([27, 64]))).toBe('G0A='))
  it('round-trips 100000 bytes', () => {
    const bytes = new Uint8Array(100000).map((_, i) => i % 256)
    const back = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))
    expect(back).toEqual(bytes)
  })
})

describe('drain budget for logos', () => {
  it('drainDelayMs never exceeds DRAIN_MAX_MS, however many bytes were written', () => {
    for (const copies of [1, 2, 3, 4, 5]) {
      expect(drainDelayMs(copies * MAX_RECEIPT_PAYLOAD_BYTES)).toBeLessThanOrEqual(DRAIN_MAX_MS)
    }
    expect(drainDelayMs(Number.MAX_SAFE_INTEGER)).toBe(DRAIN_MAX_MS)
    expect(drainDelayMs(0)).toBe(0)
  })

  it('grows with the bytes written until the cap', () => {
    expect(drainDelayMs(1000)).toBe(DRAIN_BASE_MS + 500)
    expect(drainDelayMs(2000)).toBeGreaterThan(drainDelayMs(1000))
  })

  it('covers 5 x MAX_RECEIPT_PAYLOAD_BYTES at the measured rate, under the cap', () => {
    const needMs = DRAIN_BASE_MS + Math.ceil((5 * MAX_RECEIPT_PAYLOAD_BYTES) / DRAIN_BYTES_PER_MS)
    expect(drainDelayMs(5 * MAX_RECEIPT_PAYLOAD_BYTES)).toBe(needMs)
    expect(needMs).toBeLessThanOrEqual(DRAIN_MAX_MS)
  })

  it('waits long enough for the RPP02N: the measured cases and the margin', () => {
    // 3 copies of a 6.4 KB logo slip lost the third copy at 5.0 s and printed in full at 7.5 s.
    expect(drainDelayMs(3 * 6423)).toBeGreaterThanOrEqual(7500)
    // 12 copies of a 0.6 KB text slip printed in full at 3.2 s; the budget must not be shorter than what worked.
    expect(drainDelayMs(12 * 598)).toBeGreaterThanOrEqual(3200)
    // The old rule (8 bytes/ms, 3 s cap) lost four of five 12.5 KB copies.
    expect(drainDelayMs(5 * 12460)).toBeGreaterThan(3000 * 5)
  })
})
