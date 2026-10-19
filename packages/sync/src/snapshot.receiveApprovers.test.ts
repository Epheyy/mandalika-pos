import { afterEach, describe, expect, it, vi } from 'vitest'
import { Snapshot } from './snapshot'
import { CapacitorPreferencesKV } from './storage'
import { controllableKV } from './testFixtures/controllableKV'

const SNAP_KEY = 'mandalika.pos.snapshot'
const HASH = '$argon2id$v=19$m=65536,t=1,p=4$c29tZXNhbHQ$aGFzaA'
const withHashes = () => ({
  version: 4,
  outletCode: 'JKT',
  customers: [],
  receiveApprovers: [{ userId: 'u1', displayName: 'Admin', receivePinHash: HASH }],
})

function fakePrefs(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial))
  return {
    disk,
    prefs: {
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => { disk.set(key, value) }),
      remove: vi.fn(async ({ key }: { key: string }) => { disk.delete(key) }),
      get: vi.fn(async ({ key }: { key: string }) => ({ value: disk.get(key) ?? null })),
      keys: vi.fn(async () => ({ keys: [...disk.keys()] })),
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

// A08: receive-PIN hashes are never shipped any more, and a tablet that still holds some from an
// older bundle must drop them the first time the new code loads.
describe('snapshot receiveApprovers purge', () => {
  it('constructor rewrites a stored bundle with receiveApprovers [] and keeps the rest', () => {
    const { kv } = controllableKV({ [SNAP_KEY]: JSON.stringify(withHashes()) })
    const snap = new Snapshot(kv)
    expect(snap.get().receiveApprovers).toEqual([])
    expect(snap.get().version).toBe(4)
    expect(snap.get().outletCode).toBe('JKT')
    expect(kv.get(SNAP_KEY)).not.toContain('argon2id')
    expect(kv.get(SNAP_KEY)).not.toContain('receivePinHash')
  })

  it('replace() never stores approvers even if an older server still sends them', () => {
    const { kv } = controllableKV()
    const snap = new Snapshot(kv)
    snap.replace({ ...withHashes(), products: [], categories: [], bundles: [], promotions: [], discountCodes: [], loyaltyConditions: [] } as never)
    expect(snap.get().receiveApprovers).toEqual([])
    expect(kv.get(SNAP_KEY)).not.toContain('argon2id')
  })

  it('leaves a bundle whose approvers are already empty byte for byte alone', () => {
    const raw = JSON.stringify({ version: 3, customers: [], receiveApprovers: [] })
    const { kv } = controllableKV({ [SNAP_KEY]: raw })
    new Snapshot(kv)
    expect(kv.get(SNAP_KEY)).toBe(raw)
  })

  it('Preferences hydrate clears hashes from a stored snapshot and rewrites it', async () => {
    vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { prefs, disk } = fakePrefs({ [SNAP_KEY]: JSON.stringify(withHashes()) })
    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()
    expect(JSON.parse(kv.get(SNAP_KEY) ?? '{}').receiveApprovers).toEqual([])
    expect(disk.get(SNAP_KEY)).not.toContain('argon2id')
  })

  it('the legacy localStorage lift does not carry hashes into Preferences', async () => {
    const m = new Map([[SNAP_KEY, JSON.stringify(withHashes())]])
    vi.stubGlobal('localStorage', {
      get length() { return m.size },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) },
    })
    const { prefs, disk } = fakePrefs()
    const kv = new CapacitorPreferencesKV(prefs)
    await kv.hydrate()
    expect(disk.get(SNAP_KEY)).not.toContain('argon2id')
    expect(m.has(SNAP_KEY)).toBe(false)
  })
})
