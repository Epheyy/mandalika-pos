import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KV } from '@mandalika/sync'
import { OUTLET_CACHE_KEYS, clearOutletCaches } from '../terminalBinding'
import { ApiError } from '@mandalika/api'
import { DEVICE_CODE_KEY, ensureDeviceCode, readDeviceCode, registrationGaveUp, resetRegistrationBackoff } from './deviceCode'
import { highestQueuedSeq, peekOrderNo, reserveOrderNo } from './orderRef'

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

// Test helper: take the next number and advance the (non-durable) counter.
function nextOrderNo(outletCode: string | null, deviceId: string, outletId: string | null, kv: KV): string {
  const p = peekOrderNo(outletCode, deviceId, outletId, kv)
  kv.set(p.seqKey, String(p.next))
  return p.orderNo
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

describe('reserveOrderNo (durable counter before the sale is queued)', () => {
  it('peek formats the next number without advancing the counter', () => {
    const kv = memKV(stored('AA'))
    expect(peekOrderNo('BSD', 'device-1', OUTLET, kv)).toMatchObject({ orderNo: 'BSD-AA0001', seqKey: 'mandalika.pos.orderSeq.AA', next: 1 })
    expect(peekOrderNo('BSD', 'device-1', OUTLET, kv).orderNo).toBe('BSD-AA0001')
    expect(kv.get('mandalika.pos.orderSeq.AA')).toBeNull()
  })

  it('writes the counter durably before it resolves', async () => {
    const kv = memKV(stored('AA'))
    const order: string[] = []
    const setDurable = vi.fn(async (k: string, v: string) => { order.push(`durable:${k}=${v}`) })
    const r = await reserveOrderNo('BSD', 'device-1', OUTLET, { ...kv, setDurable })
    order.push('resolved')
    expect(r.orderNo).toBe('BSD-AA0001')
    expect(r.error).toBeUndefined()
    expect(order).toEqual(['durable:mandalika.pos.orderSeq.AA=1', 'resolved'])
  })

  it('still returns a number, updates the mirror and reports the error when the durable write fails', async () => {
    const kv = memKV(stored('AA'))
    const boom = new Error('disk full')
    const failing: KV = { ...kv, setDurable: async () => { throw boom } }
    const r = await reserveOrderNo('BSD', 'device-1', OUTLET, failing)
    expect(r.orderNo).toBe('BSD-AA0001')
    expect(r.error).toBe(boom)
    expect(kv.get('mandalika.pos.orderSeq.AA')).toBe('1')
    expect((await reserveOrderNo('BSD', 'device-1', OUTLET, failing)).orderNo).toBe('BSD-AA0002')
  })

  it('uses the legacy counter and format without a code', async () => {
    const kv = memKV({ 'mandalika.pos.orderSeq': '4' })
    const r = await reserveOrderNo('BSD', 'device-1', OUTLET, kv)
    expect(r.orderNo).toMatch(/^BSD-[0-9A-Z]0005$/)
    expect(kv.get('mandalika.pos.orderSeq')).toBe('5')
  })
})

describe('ensureDeviceCode back-off', () => {
  const gaveUp = () => registrationGaveUp(OUTLET, 'device-bo')

  it.each([403, 404, 400])('backs off after a %i until reset, and does not call the server again', async (status) => {
    resetRegistrationBackoff()
    const kv = memKV()
    const registerDevice = vi.fn().mockRejectedValue(new ApiError(status, 'nope'))
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-bo')).toBeNull()
    expect(gaveUp()).toBe(true)
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-bo')).toBeNull()
    expect(registerDevice).toHaveBeenCalledTimes(1)
    resetRegistrationBackoff()
    expect(gaveUp()).toBe(false)
  })

  it.each([0, 500, 503, 401, 408, 409, 429])('keeps retrying after a %i', async (status) => {
    resetRegistrationBackoff()
    const kv = memKV()
    const registerDevice = vi.fn().mockRejectedValue(new ApiError(status, 'later'))
    await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-bo')
    expect(gaveUp()).toBe(false)
    await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-bo')
    expect(registerDevice).toHaveBeenCalledTimes(2)
  })
})

describe('ensureDeviceCode timed back-off', () => {
  afterEach(() => { vi.useRealTimers(); resetRegistrationBackoff() })

  it('retries after 15 minutes without a remount', async () => {
    resetRegistrationBackoff()
    vi.useFakeTimers()
    const kv = memKV()
    const registerDevice = vi.fn().mockRejectedValueOnce(new ApiError(404, 'not deployed yet')).mockResolvedValue({ code: 'AG' })
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-t')).toBeNull()
    vi.advanceTimersByTime(14 * 60_000)
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-t')).toBeNull()
    expect(registerDevice).toHaveBeenCalledTimes(1)
    expect(registrationGaveUp(OUTLET, 'device-t')).toBe(true)
    vi.advanceTimersByTime(2 * 60_000)
    expect(registrationGaveUp(OUTLET, 'device-t')).toBe(false)
    expect(await ensureDeviceCode(kv, { registerDevice }, OUTLET, 'device-t')).toBe('AG')
    expect(registerDevice).toHaveBeenCalledTimes(2)
  })
})

describe('highestQueuedSeq / reserve-time floor from the pending queue', () => {
  it('finds the highest sequence for the code and ignores other formats', () => {
    expect(highestQueuedSeq('AA', ['BSD-AA0003', 'BSD-AA0010', 'BSD-AB0099', 'BSD-A0500', 'BSD-AA', 'x', 'OUT-AA10000'])).toBe(10000)
    expect(highestQueuedSeq('AA', [])).toBe(0)
  })

  it('a rolled-back counter is raised above the numbers still queued', async () => {
    const kv = memKV({ ...stored('AA'), 'mandalika.pos.orderSeq.AA': '2' })
    const r = await reserveOrderNo('BSD', 'device-1', OUTLET, kv, ['BSD-AA0001', 'BSD-AA0002', 'BSD-AA0003', 'BSD-AA0004'])
    expect(r.orderNo).toBe('BSD-AA0005')
    expect(kv.get('mandalika.pos.orderSeq.AA')).toBe('5')
  })

  it('does not lower a counter that is already ahead', async () => {
    const kv = memKV({ ...stored('AA'), 'mandalika.pos.orderSeq.AA': '9' })
    expect((await reserveOrderNo('BSD', 'device-1', OUTLET, kv, ['BSD-AA0001'])).orderNo).toBe('BSD-AA0010')
  })

  it('ignores the queue in the legacy format', async () => {
    const kv = memKV({ 'mandalika.pos.orderSeq': '1' })
    const r = await reserveOrderNo('BSD', 'device-1', OUTLET, kv, ['BSD-AA0050'])
    expect(r.orderNo).toMatch(/^BSD-[0-9A-Z]0002$/)
  })
})
