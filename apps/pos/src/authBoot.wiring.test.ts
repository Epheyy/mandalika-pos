import { describe, expect, it, vi } from 'vitest'
import type { KV } from '@mandalika/sync'

function memKV(): KV {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v),
    removeDurable: async (k) => void m.delete(k),
  }
}

const h = vi.hoisted(() => ({ active: null as unknown, def: null as unknown }))
vi.mock('@mandalika/sync', () => ({
  get defaultKV() {
    return h.def
  },
  getKV: () => h.active,
}))

describe('session persistence resolves the KV at call time', () => {
  it('writes land in the store swapped in AFTER the module was imported', async () => {
    const local = memKV()
    h.def = local
    h.active = local
    const { persistSession, dropSession, REFRESH_KEY, USER_KEY } = await import('./authBoot')

    const secure = memKV() // initSecureKV() swapping stores after import
    h.active = secure
    persistSession({ refresh: 'r1', user: { id: 'u' } as never })
    expect(secure.get(REFRESH_KEY)).toBe('r1')
    expect(secure.get(USER_KEY)).not.toBeNull()
    expect(local.get(REFRESH_KEY)).toBeNull()

    local.set(REFRESH_KEY, 'legacy')
    dropSession()
    expect(secure.get(REFRESH_KEY)).toBeNull()
    expect(local.get(REFRESH_KEY)).toBeNull()
  })
})
