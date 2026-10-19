import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropLegacyPinLockout, LEGACY_PIN_LOCKOUT_KEY } from './legacyPinLockout'

// A08: the on-device PIN lockout (resettable by clearing storage) is gone; the server owns lockout.
let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    get length() { return store.size },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('dropLegacyPinLockout', () => {
  it('removes the old lockout key and leaves everything else', () => {
    store.set(LEGACY_PIN_LOCKOUT_KEY, '{"failures":3}')
    store.set('mandalika.pos.outbox', '[]')
    dropLegacyPinLockout()
    expect(store.has(LEGACY_PIN_LOCKOUT_KEY)).toBe(false)
    expect(store.get('mandalika.pos.outbox')).toBe('[]')
    expect(LEGACY_PIN_LOCKOUT_KEY).toBe('mandalika.pos.pinLockout')
  })

  it('is a no-op when the key is absent', () => {
    expect(() => dropLegacyPinLockout()).not.toThrow()
  })
})
