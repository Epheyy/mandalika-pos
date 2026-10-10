import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import type { KV } from './storage'

// ── In-memory KV (mirrors the pattern in engine.receive-accepted.test.ts) ───

function memKV(): KV {
  const store = new Map<string, string>()
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
    setDurable: async (key, value) => { store.set(key, value) },
    removeDurable: async (key) => { store.delete(key) },
  }
}

// ── Minimal pull-bundle so resync() can initialise the engine ────────────────

const PULL_BUNDLE = {
  version: 1,
  products: [],
  categories: [],
  bundles: [],
  customers: [],
  promotions: [],
  discountCodes: [],
  loyaltyConditions: [],
}

// ── ApiLike that answers pull but never flushes (so outbox stays pending) ───

function makeOfflineApi(): ApiLike {
  return {
    request: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path.includes('/sync/pull')) {
        return Promise.resolve({ data: PULL_BUNDLE })
      }
      if (method === 'GET' && path.includes('/sync/inbound')) {
        return Promise.resolve({ data: [] })
      }
      // Reject batch POST so items stay pending
      return Promise.reject(new Error('offline'))
    }),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SyncEngine.pendingStockDeltas — SP-CRM-9c', () => {
  beforeEach(() => {
    // Node 24+ exposes navigator with onLine=undefined (falsy); stub to true so
    // flush() doesn't bail early — but our api rejects batch so items stay pending.
    vi.stubGlobal('navigator', { onLine: true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns {} when the outbox is empty', async () => {
    const engine = new SyncEngine(makeOfflineApi(), {}, memKV())
    await engine.resync()
    expect(engine.pendingStockDeltas()).toEqual({})
  })

  it('accumulates quantities from two pending orders for the same variant', async () => {
    const engine = new SyncEngine(makeOfflineApi(), {}, memKV())
    await engine.resync()

    // First order: 2 × p1|10ml, 1 × p2|30ml
    await engine.enqueue('order', {
      items: [
        { productId: 'p1', variantSize: '10ml', quantity: 2 },
        { productId: 'p2', variantSize: '30ml', quantity: 1 },
      ],
    })

    // Second order: 3 × p1|10ml (same variant — should accumulate)
    await engine.enqueue('order', {
      items: [
        { productId: 'p1', variantSize: '10ml', quantity: 3 },
      ],
    })

    const deltas = engine.pendingStockDeltas()
    expect(deltas['p1|10ml']).toBe(5)   // 2 + 3
    expect(deltas['p2|30ml']).toBe(1)
  })

  it('includes reward lines (isReward=true) in the deltas', async () => {
    const engine = new SyncEngine(makeOfflineApi(), {}, memKV())
    await engine.resync()

    await engine.enqueue('order', {
      items: [
        { productId: 'p1', variantSize: '10ml', quantity: 1 },
        { productId: 'pReward', variantSize: '5ml', quantity: 1, isReward: true, rewardConditionId: 'rc1' },
      ],
    })

    const deltas = engine.pendingStockDeltas()
    expect(deltas['p1|10ml']).toBe(1)
    expect(deltas['pReward|5ml']).toBe(1)
  })

  it('ignores non-order outbox items (shift_open, refund, etc.)', async () => {
    const engine = new SyncEngine(makeOfflineApi(), {}, memKV())
    await engine.resync()

    await engine.enqueue('shift_open', { startingCash: 100000 })
    await engine.enqueue('order', {
      items: [{ productId: 'p1', variantSize: '10ml', quantity: 2 }],
    })

    const deltas = engine.pendingStockDeltas()
    expect(Object.keys(deltas)).toEqual(['p1|10ml'])
    expect(deltas['p1|10ml']).toBe(2)
  })
})
