import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { Snapshot } from './snapshot'
import { KNOWN_CUSTOMERS_KEY } from './knownCustomers'
import { controllableKV } from './testFixtures/controllableKV'

type Bundle = components['schemas']['SyncPullBundle']

const SNAP_KEY = 'mandalika.pos.snapshot'

const oldCustomers = [
  { id: 'c1', name: 'Alice', phone: '081234567890', email: 'alice@example.invalid', points: 5, totalSpent: 1, visitCount: 1, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Budi', phone: '081200000002', points: 0, totalSpent: 0, visitCount: 0, createdAt: '2026-01-02T00:00:00Z' },
]

// A30: tablets that stored a browsable customer list before this change must drop it the first
// time the new code loads, and must never carry it into the new known-customers memory.
describe('snapshot customer purge', () => {
  it('rewrites a stored bundle with customers [] and keeps everything else', () => {
    const stored: Bundle = { version: 7, outletCode: 'JKT', products: [], categories: [], bundles: [], customers: oldCustomers as never, promotions: [], discountCodes: [], loyaltyConditions: [] }
    const { kv } = controllableKV({ [SNAP_KEY]: JSON.stringify(stored) })

    const snap = new Snapshot(kv)

    expect(snap.get().customers).toEqual([])
    expect(snap.get().version).toBe(7)
    expect(snap.get().outletCode).toBe('JKT')
    const persisted = JSON.parse(kv.get(SNAP_KEY) ?? '{}')
    expect(persisted.customers).toEqual([])
    expect(kv.get(SNAP_KEY)).not.toContain('alice@example.invalid')
    expect(kv.get(SNAP_KEY)).not.toContain('081234567890')
  })

  it('never copies the old list into the known-customers memory', () => {
    const stored = { version: 7, customers: oldCustomers }
    const { kv } = controllableKV({ [SNAP_KEY]: JSON.stringify(stored) })
    new Snapshot(kv)
    expect(kv.get(KNOWN_CUSTOMERS_KEY)).toBeNull()
  })

  it('leaves a bundle that already has no customers byte for byte alone', () => {
    const raw = JSON.stringify({ version: 3, customers: [] })
    const { kv } = controllableKV({ [SNAP_KEY]: raw })
    new Snapshot(kv)
    expect(kv.get(SNAP_KEY)).toBe(raw)
  })

  it('replace() never stores customers even if an old server still sends them', () => {
    const { kv } = controllableKV()
    const snap = new Snapshot(kv)
    snap.replace({ version: 9, products: [], categories: [], bundles: [], customers: oldCustomers as never, promotions: [], discountCodes: [], loyaltyConditions: [] })
    expect(snap.get().customers).toEqual([])
    expect(kv.get(SNAP_KEY)).not.toContain('Alice')
    expect(new Snapshot(kv).get().version).toBe(9)
  })
})
