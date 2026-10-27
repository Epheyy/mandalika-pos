import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// C3: the server takes one unit of the outlet's giveaway item per completed order (ledger hook), so every
// sale the tablet counts as pending also counts one giveaway unit in the displayed stock.

const GIVEAWAY = { productId: 'bag', variantSize: 'std', productName: 'Tote Bag', stock: 10 }
const BAG = 'bag|std'

function makeServer(giveaway: typeof GIVEAWAY | undefined) {
  const s = { giveaway, batchOk: true }

  type Body = { items: { idempotencyKey: string }[] }
  const request = vi.fn(async (method: string, path: string, body?: Body) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      return {
        data: {
          version: 1,
          products: [], categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
          ...(s.giveaway ? { outletGiveaway: s.giveaway } : {}),
        },
      }
    }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    if (method === 'POST' && path.includes('/sync/batch')) {
      if (!s.batchOk) throw new TypeError('network')
      const results = (body?.items ?? []).map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' }))
      return { data: { processed: results.length, version: 1, results } }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}

async function setup(giveaway: typeof GIVEAWAY | undefined) {
  const { s, api } = makeServer(giveaway)
  const engine = new SyncEngine(api, {}, controllableKV().kv, { actor: null })
  await engine.resync()
  return { s, engine }
}
const sale = (pid = 'p1', qty = 1) => ({ items: [{ productId: pid, variantSize: '10ml', quantity: qty }] })

beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('C3 giveaway stock delta in pendingStockDeltas', () => {
  it('adds one giveaway unit per pending order, whatever the cart holds', async () => {
    const { engine } = await setup(GIVEAWAY)
    await engine.enqueue('order', sale('p1', 3))
    await engine.enqueue('order', sale('p2', 1))
    expect(engine.pendingStockDeltas()).toEqual({ 'p1|10ml': 3, 'p2|10ml': 1, [BAG]: 2 })
  })

  it('stacks on top of a sold or reward line of the same SKU', async () => {
    const { engine } = await setup(GIVEAWAY)
    await engine.enqueue('order', { items: [{ productId: 'bag', variantSize: 'std', quantity: 2 }] })
    expect(engine.pendingStockDeltas()[BAG]).toBe(3)
  })

  it('adds nothing without a configured giveaway (older server, disabled, none)', async () => {
    const { engine } = await setup(undefined)
    await engine.enqueue('order', sale())
    expect(engine.pendingStockDeltas()).toEqual({ 'p1|10ml': 1 })
  })

  it('ignores non-order outbox items', async () => {
    const { engine } = await setup(GIVEAWAY)
    await engine.enqueue('shift_open', { startingCash: 1 })
    expect(engine.pendingStockDeltas()).toEqual({})
  })

  it('keeps counting an acknowledged order until the next pull retires it, and not after', async () => {
    const { s, engine } = await setup(GIVEAWAY)
    await engine.enqueue('order', sale())
    vi.stubGlobal('navigator', { onLine: true })
    try { await engine.flushNow() } finally { vi.stubGlobal('navigator', { onLine: false }) }
    expect(engine.unsettledCount()).toBe(0) // acked and pruned
    expect(engine.pendingStockDeltas()[BAG]).toBe(1)
    await engine.resync()
    expect(s.giveaway).toBe(GIVEAWAY)
    expect(engine.pendingStockDeltas()[BAG]).toBeUndefined()
  })

  it('follows the config of the latest pull (disabled giveaway stops counting)', async () => {
    const { s, engine } = await setup(GIVEAWAY)
    await engine.enqueue('order', sale())
    expect(engine.pendingStockDeltas()[BAG]).toBe(1)
    s.giveaway = undefined
    await engine.resync()
    expect(engine.pendingStockDeltas()[BAG]).toBeUndefined()
  })
})
