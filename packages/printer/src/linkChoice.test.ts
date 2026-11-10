import { describe, expect, it } from 'vitest'
import type { ClassicBondedDevice } from './classicTypes'
import { chooseLink, drainDelayMs, findBonded, toBase64 } from './linkChoice'

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
    [800, 400],
    [100000, 3000],
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
