import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapacitorPreferencesKV } from './storage'

const SNAP_KEY = 'mandalika.pos.snapshot'
const OTHER_KEY = 'mandalika.pos.outbox'

const oldSnapshot = JSON.stringify({
  version: 4,
  outletCode: 'JKT',
  customers: [{ id: 'c1', name: 'Alice', phone: '081234567890', email: 'alice@example.invalid', points: 1 }],
  discountCodes: [{ id: 'd1', code: 'VIP', customerId: 'c1', customerName: 'Alice' }],
})

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
    m,
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

afterEach(() => vi.unstubAllGlobals())

// A30: a customer list stored by older code must not survive in the WebView's localStorage once the
// native Preferences store has taken over, and must not be carried into Preferences either.
describe('legacy snapshot customers during the Preferences migration', () => {
  it('copies the legacy snapshot without customers or holder names and removes the localStorage key', async () => {
    const ls = fakeLocalStorage({ [SNAP_KEY]: oldSnapshot, [OTHER_KEY]: '[]' })
    vi.stubGlobal('localStorage', ls)
    const { prefs, disk } = fakePrefs()

    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()

    const migrated = JSON.parse(kv.get(SNAP_KEY) ?? '{}')
    expect(migrated.version).toBe(4)
    expect(migrated.outletCode).toBe('JKT')
    expect(migrated.customers).toEqual([])
    expect(migrated.discountCodes[0]).toEqual({ id: 'd1', code: 'VIP', customerId: 'c1' })
    expect(disk.get(SNAP_KEY)).not.toContain('Alice')
    expect(ls.getItem(SNAP_KEY)).toBeNull()
    expect(ls.getItem(OTHER_KEY)).toBe('[]') // other legacy keys are left to the existing behaviour
  })

  it('removes the localStorage copy even when Preferences already holds a snapshot', async () => {
    const ls = fakeLocalStorage({ [SNAP_KEY]: oldSnapshot })
    vi.stubGlobal('localStorage', ls)
    const { prefs } = fakePrefs({ [SNAP_KEY]: JSON.stringify({ version: 9, customers: [] }) })

    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()

    expect(JSON.parse(kv.get(SNAP_KEY) ?? '{}').version).toBe(9)
    expect(ls.getItem(SNAP_KEY)).toBeNull()
  })

  it('keeps the legacy copy when the Preferences write fails (nothing is lost) and rejects', async () => {
    const ls = fakeLocalStorage({ [SNAP_KEY]: oldSnapshot })
    vi.stubGlobal('localStorage', ls)
    const { prefs } = fakePrefs()
    prefs.failSet = true

    await expect(new CapacitorPreferencesKV(prefs).hydrate()).rejects.toThrow('bridge error')
    expect(ls.getItem(SNAP_KEY)).not.toBeNull()
  })

  it('also clears customers from a Preferences snapshot written by older code', async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    const { prefs, disk } = fakePrefs({ [SNAP_KEY]: oldSnapshot })

    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()

    expect(JSON.parse(kv.get(SNAP_KEY) ?? '{}').customers).toEqual([])
    expect(disk.get(SNAP_KEY)).not.toContain('alice@example.invalid')
  })
})
