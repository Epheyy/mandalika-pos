import { describe, expect, it, vi } from 'vitest'
import type { KV } from '@mandalika/sync'
import { OUTLET_CACHE_KEYS, clearOutletCaches } from '../terminalBinding'
import { DEVICE_CODE_KEY, ensureDeviceCode, readDeviceCode } from './deviceCode'
import { nextOrderNo } from './orderRef'

function memKV(seed: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(seed))
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v),
    removeDurable: async (k) => void m.delete(k),
  }
}

const OUTLET = 'outlet-uuid-1'
const stored = (code: string, outletId = OUTLET) => ({ [DEVICE_CODE_KEY]: JSON.stringify({ outletId, code }) })

describe('nextOrderNo with a server device code', () => {
  it('numbers sales {OUTLET}-{CODE}{SEQ} counting from 0001', () => {
    const kv = memKV(stored('AA'))
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toBe('BSD-AA0001')
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toBe('BSD-AA0002')
  })

  it('keeps one counter per code and leaves the legacy counter alone', () => {
    const kv = memKV({ ...stored('AB'), 'mandalika.pos.orderSeq': '41', 'mandalika.pos.orderSeq.AA': '7' })
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toBe('BSD-AB0001')
    expect(kv.get('mandalika.pos.orderSeq')).toBe('41')
    expect(kv.get('mandalika.pos.orderSeq.AA')).toBe('7')
    expect(kv.get('mandalika.pos.orderSeq.AB')).toBe('1')
  })

  it('grows past four digits', () => {
    const kv = memKV({ ...stored('AA'), 'mandalika.pos.orderSeq.AA': '9999' })
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toBe('BSD-AA10000')
  })

  it('falls back to the legacy format and counter when there is no code', () => {
    const kv = memKV({ 'mandalika.pos.orderSeq': '9' })
    const no = nextOrderNo('BSD', 'device-1', OUTLET, kv)
    expect(no).toMatch(/^BSD-[0-9A-Z]0010$/)
    expect(kv.get('mandalika.pos.orderSeq')).toBe('10')
  })

  it('ignores a code registered for another outlet', () => {
    const kv = memKV(stored('AA', 'some-other-outlet'))
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toMatch(/^BSD-[0-9A-Z]0001$/)
    expect(kv.get('mandalika.pos.orderSeq.AA')).toBeNull()
  })

  it('uses the legacy format when the bound outlet is unknown', () => {
    const kv = memKV(stored('AA'))
    expect(nextOrderNo('BSD', 'device-1', null, kv)).toMatch(/^BSD-[0-9A-Z]0001$/)
  })

  it('treats a malformed stored code as absent', () => {
    for (const raw of ['nope', '{}', JSON.stringify({ outletId: OUTLET, code: 'a1' }), JSON.stringify({ outletId: OUTLET, code: 'A' })]) {
      expect(readDeviceCode(memKV({ [DEVICE_CODE_KEY]: raw }), OUTLET)).toBeNull()
    }
  })
})

describe('ensureDeviceCode', () => {
  it('registers once and stores {outletId, code} durably', async () => {
    const kv = memKV()
    const registerDevice = vi.fn().mockResolvedValue({ code: 'AC' })
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBe('AC')
    expect(registerDevice).toHaveBeenCalledWith('device-1')
    expect(readDeviceCode(kv, OUTLET)).toBe('AC')
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBe('AC')
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })

  it('registers again when the stored code belongs to another outlet', async () => {
    const kv = memKV(stored('AA', 'old-outlet'))
    const registerDevice = vi.fn().mockResolvedValue({ code: 'AD' })
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBe('AD')
    expect(readDeviceCode(kv, OUTLET)).toBe('AD')
    expect(readDeviceCode(kv, 'old-outlet')).toBeNull()
  })

  it('never throws: a failure leaves selling on the legacy number and can be retried', async () => {
    const kv = memKV()
    const registerDevice = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ code: 'AE' })
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBeNull()
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toMatch(/^BSD-[0-9A-Z]0001$/)
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBe('AE')
    expect(nextOrderNo('BSD', 'device-1', OUTLET, kv)).toBe('BSD-AE0001')
  })

  it('rejects an invalid code from the server', async () => {
    const kv = memKV()
    const registerDevice = vi.fn().mockResolvedValue({ code: '' })
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-1')).toBeNull()
    expect(kv.get(DEVICE_CODE_KEY)).toBeNull()
  })

  it('shares one in-flight registration', async () => {
    const kv = memKV()
    const registerDevice = vi.fn().mockResolvedValue({ code: 'AF' })
    const api = { registerDevice }
    const [a, b] = await Promise.all([
      ensureDeviceCode(kv, api, OUTLET, 'device-1'),
      ensureDeviceCode(kv, api, OUTLET, 'device-1'),
    ])
    expect([a, b]).toEqual(['AF', 'AF'])
    expect(registerDevice).toHaveBeenCalledTimes(1)
  })
})

describe('releasing the terminal', () => {
  it('clears the device code with the other outlet data', () => {
    expect(OUTLET_CACHE_KEYS).toContain(DEVICE_CODE_KEY)
    const kv = memKV(stored('AA'))
    clearOutletCaches(kv, OUTLET)
    expect(readDeviceCode(kv, OUTLET)).toBeNull()
  })
})
