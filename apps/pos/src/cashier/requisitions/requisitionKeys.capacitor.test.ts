import { describe, expect, it, vi } from 'vitest'
import type { StockRequisitionInput } from '@mandalika/api'
import { CapacitorPreferencesKV } from '../../../../../packages/sync/src/storage'
import { createRequisitionKeys, pendingCreateStorageKey } from './requisitionKeys'

// Review H1: on Android only keys starting with "mandalika." are loaded back from Preferences at boot
// (packages/sync/src/storage.ts KEY_PREFIX). The pending create must survive that restart, or a second PB
// can be created. The class is exported "for tests" from storage.ts (no change to packages/sync).

const scope = { userId: 'u1', outletId: 'o1' }
const form = { lines: [{ productId: 'p' }], note: 'n' }
const input = (qty: number): StockRequisitionInput => ({ items: [{ productId: 'p', variantSize: 'M', requestedQty: qty }] })

function fakePreferences(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial))
  return {
    disk,
    plugin: {
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => { disk.set(key, value) }),
      remove: vi.fn(async ({ key }: { key: string }) => { disk.delete(key) }),
      get: vi.fn(async ({ key }: { key: string }) => ({ value: disk.get(key) ?? null })),
      keys: vi.fn(async () => ({ keys: [...disk.keys()] })),
    },
  }
}
const hydratedFrom = async (disk: Map<string, string>) => {
  const kv = new CapacitorPreferencesKV(fakePreferences(Object.fromEntries(disk)).plugin)
  await kv.hydrate()
  return kv
}

describe('requisitionKeys survives an Android restart (CapacitorPreferencesKV)', () => {
  it('the storage key is in the mandalika. namespace', () => {
    expect(pendingCreateStorageKey(scope)).toMatch(/^mandalika\.pos\.requisition\.pendingCreate\./)
  })

  it('an unconfirmed create written through Preferences is read back by a FRESH hydrated instance', async () => {
    const fp = fakePreferences()
    const first = new CapacitorPreferencesKV(fp.plugin)
    await first.hydrate()
    const key = await createRequisitionKeys(first, scope).beginCreate('sig', input(2), form)
    const restarted = createRequisitionKeys(await hydratedFrom(fp.disk), scope)
    expect(restarted.loadPendingCreate()).toEqual({ sig: 'sig', key, input: input(2), form, sent: true })
    expect(await restarted.beginCreate('sig', input(2), form)).toBe(key)
  })

  it('a cleared record stays gone after a restart, and so does one whose removal failed (resolved marker)', async () => {
    const fp = fakePreferences()
    const first = new CapacitorPreferencesKV(fp.plugin)
    await first.hydrate()
    const keys = createRequisitionKeys(first, scope)
    await keys.beginCreate('sig', input(1), form)
    await keys.clearPendingCreate()
    expect(createRequisitionKeys(await hydratedFrom(fp.disk), scope).loadPendingCreate()).toBeNull()

    const failingRemove = Object.assign(Object.create(first) as CapacitorPreferencesKV, {
      removeDurable: () => Promise.reject(new Error('disk')),
    })
    const k2 = createRequisitionKeys(failingRemove, scope)
    await k2.beginCreate('sig2', input(1), form)
    await k2.clearPendingCreate()
    expect(fp.disk.get(pendingCreateStorageKey(scope))).toContain('resolved')
    expect(createRequisitionKeys(await hydratedFrom(fp.disk), scope).loadPendingCreate()).toBeNull()
  })

  it('pins the reason: a key outside the mandalika. namespace is written to disk but never loaded back', async () => {
    const fp = fakePreferences()
    const first = new CapacitorPreferencesKV(fp.plugin)
    await first.hydrate()
    const stray = 'pos.requisition.pendingCreate.u1.o1'
    await first.setDurable(stray, '{"sig":"s"}')
    expect(fp.disk.has(stray)).toBe(true)
    expect((await hydratedFrom(fp.disk)).get(stray)).toBeNull()
  })
})
