import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacitorPreferencesKV, defaultKV } from './storage'
import { PendingCredits } from './pendingCredits'
import { controllableKV } from './testFixtures/controllableKV'

function fakePrefs(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial))
  const prefs = {
    failSet: false,
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      if (prefs.failSet) throw new Error('bridge error (synthetic)')
      disk.set(key, value)
    }),
    remove: vi.fn(async ({ key }: { key: string }) => { disk.delete(key) }),
    get: vi.fn(async ({ key }: { key: string }) => ({ value: disk.get(key) ?? null })),
    keys: vi.fn(async () => ({ keys: [...disk.keys()] })),
  }
  return { prefs, disk }
}

function fakeLocalStorage(entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries))
  return {
    setThrows: false,
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem(this: { setThrows: boolean }, k: string, v: string) {
      if (this.setThrows) throw new DOMException('quota', 'QuotaExceededError')
      m.set(k, v)
    },
    removeItem: (k: string) => { m.delete(k) },
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

describe('CapacitorPreferencesKV durable writes', () => {
  it('does not move the mirror ahead of disk when prefs.set rejects', async () => {
    const { prefs, disk } = fakePrefs()
    const kv = new CapacitorPreferencesKV(prefs)
    await kv.setDurable('mandalika.a', 'old')
    prefs.failSet = true
    await expect(kv.setDurable('mandalika.a', 'new')).rejects.toThrow('bridge error')
    expect(kv.get('mandalika.a')).toBe('old')
    expect(disk.get('mandalika.a')).toBe('old')
    await expect(kv.setDurable('mandalika.b', 'x')).rejects.toThrow()
    expect(kv.get('mandalika.b')).toBeNull()
  })

  it('awaits the plugin before updating the mirror on success', async () => {
    const { prefs } = fakePrefs()
    let release!: () => void
    prefs.set.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const kv = new CapacitorPreferencesKV(prefs)
    const write = kv.setDurable('mandalika.a', 'v')
    expect(kv.get('mandalika.a')).toBeNull() // not visible before the plugin resolved
    release()
    await write
    expect(kv.get('mandalika.a')).toBe('v')
  })

  it('removeDurable keeps the mirror when the plugin rejects', async () => {
    const { prefs } = fakePrefs({ 'mandalika.a': 'v' })
    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()
    prefs.remove.mockRejectedValueOnce(new Error('bridge error (synthetic)'))
    await expect(kv.removeDurable('mandalika.a')).rejects.toThrow()
    expect(kv.get('mandalika.a')).toBe('v')
  })

  it('hydrate surfaces a failed localStorage migration write instead of starting empty', async () => {
    const { prefs } = fakePrefs()
    prefs.failSet = true
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'mandalika.pos.outbox': '[{"queued":"sale"}]' }))
    const kv = new CapacitorPreferencesKV(prefs)
    await expect(kv.hydrate()).rejects.toThrow('bridge error')
    expect(kv.get('mandalika.pos.outbox')).toBeNull() // not claimed as migrated
  })

  it('hydrate migrates legacy localStorage keys durably when writes succeed', async () => {
    const { prefs, disk } = fakePrefs({ 'mandalika.native': 'n' })
    vi.stubGlobal('localStorage', fakeLocalStorage({ 'mandalika.pos.outbox': '[]', 'other.key': 'z' }))
    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()
    expect(disk.get('mandalika.pos.outbox')).toBe('[]')
    expect(disk.has('other.key')).toBe(false)
    expect(kv.get('mandalika.native')).toBe('n')
    expect(kv.get('mandalika.pos.outbox')).toBe('[]')
  })
})

describe('initSecureKV', () => {
  const load = async (native: boolean, prefs: unknown) => {
    vi.resetModules()
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native } }))
    vi.doMock('@capacitor/preferences', () => ({ Preferences: prefs }))
    return import('./storage')
  }

  it('rejects when hydrate fails on a native build (no silent localStorage fallback)', async () => {
    const { prefs } = fakePrefs()
    prefs.keys.mockRejectedValue(new Error('prefs unreadable (synthetic)'))
    const storage = await load(true, prefs)
    await expect(storage.initSecureKV()).rejects.toThrow('prefs unreadable')
    expect(storage.getKV()).toBe(storage.defaultKV)
  })

  it('keeps localStorage on the web shell', async () => {
    const { prefs } = fakePrefs()
    const storage = await load(false, prefs)
    expect(await storage.initSecureKV()).toBe(storage.defaultKV)
  })

  it('switches to Preferences after a successful native hydrate', async () => {
    const { prefs } = fakePrefs({ 'mandalika.a': '1' })
    const storage = await load(true, prefs)
    const kv = await storage.initSecureKV()
    expect(kv).not.toBe(storage.defaultKV)
    expect(kv.get('mandalika.a')).toBe('1')
  })
})

describe('LocalStorageKV durable writes', () => {
  it('rejects instead of swallowing a quota error, and sync set stays non-throwing', async () => {
    const ls = fakeLocalStorage()
    vi.stubGlobal('localStorage', ls)
    await defaultKV.setDurable('k', 'v')
    expect(defaultKV.get('k')).toBe('v')
    ls.setThrows = true
    await expect(defaultKV.setDurable('k', 'w')).rejects.toThrow()
    expect(defaultKV.get('k')).toBe('v')
    expect(() => defaultKV.set('k', 'w')).not.toThrow() // legacy path unchanged
  })
})

describe('PendingCredits corrupt storage', () => {
  it('quarantines unreadable bytes before they can be overwritten and starts empty', async () => {
    const { kv, store } = controllableKV({ 'mandalika.pos.pendingCredits': '[{"idempotencyKey":' })
    const credits = new PendingCredits(kv)
    expect(credits.list()).toEqual([])
    credits.add({ idempotencyKey: 'dev:r1', lines: [], ackVersion: null })
    const keys = [...store.keys()].filter((k) => k.startsWith('mandalika.pendingCredits.corrupt.'))
    expect(keys).toHaveLength(1)
    expect(store.get(keys[0])).toBe('[{"idempotencyKey":')
    expect(credits.list().map((c) => c.idempotencyKey)).toEqual(['dev:r1'])
  })
})
