import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { OUTBOX_KEY } from './outbox'
import { SYNCED_REFUNDS_KEY } from './syncedRefunds'
import { SETTLING_DEBITS_KEY } from './settlingDebits'
import { controllableKV } from './testFixtures/controllableKV'

// A15: a sold SKU's stock must not jump back up between the order's ack and the next pull.
// Display = snapshot stock - pending deltas, so the engine keeps acked-but-unpulled debits.

type Body = { items: { type: string; idempotencyKey: string; payload: { items?: { quantity: number }[] } }[] }
interface PullPlan { gate?: Promise<void>; stock?: number; omitProduct?: boolean }

function makeServer() {
  const s = {
    stock: 5, // what the server holds right now
    pullPlans: [] as PullPlan[],
    batchMode: 'ok' as 'ok' | 'lost' | 'busy' | 'park' | 'rejectMulti',
    batches: [] as string[][],
  }
  const bundle = (stock: number, omit: boolean) => ({
    version: 1,
    products: omit ? [] : [{ id: 'p1', name: 'A', isActive: true, variants: [{ size: '10ml', price: 1, stock, sku: '' }] }],
    categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
  })
  const request = vi.fn(async (method: string, path: string, body?: Body) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      const plan = s.pullPlans.shift() ?? {}
      if (plan.gate) await plan.gate
      return { data: bundle(plan.stock ?? s.stock, plan.omitProduct ?? false) }
    }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    if (method === 'POST' && path.includes('/sync/batch') && body) {
      s.batches.push(body.items.map((i) => i.idempotencyKey))
      if (s.batchMode === 'rejectMulti' && body.items.length > 1) throw Object.assign(new Error('bad request'), { status: 400, kind: 'http' })
      if (s.batchMode === 'lost') {
        s.stock -= 2 // committed on the server, but the response never arrives
        throw new TypeError('network')
      }
      const results = body.items.map((i) => {
        if (s.batchMode === 'busy') return { idempotencyKey: i.idempotencyKey, status: 'error', error: 'sibuk', code: 'busy', retryable: true }
        if (s.batchMode === 'park') return { idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'conflict', retryable: false }
        return { idempotencyKey: i.idempotencyKey, status: 'ok' }
      })
      return { data: { processed: results.length, version: 1, results } }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}

const SKU = 'p1|10ml'
const shown = (e: SyncEngine) => {
  const v = e.getSnapshot().products?.[0]?.variants[0]
  return v ? v.stock - (e.pendingStockDeltas()[SKU] ?? 0) : null
}
const order = (qty = 2) => ({ items: [{ productId: 'p1', variantSize: '10ml', quantity: qty }] })

async function send(e: SyncEngine) {
  vi.stubGlobal('navigator', { onLine: true })
  try { await e.flushNow() } finally { vi.stubGlobal('navigator', { onLine: false }) }
}

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { p, open }
}

// Offline while queueing (enqueue would otherwise flush at once); `send` goes online just for the flush.
beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function setup(opts: { actor?: () => { outletId: string; userId: string } | null; kv?: ReturnType<typeof controllableKV> } = {}) {
  const { s, api } = makeServer()
  const k = opts.kv ?? controllableKV()
  const engine = new SyncEngine(api, {}, k.kv, { actor: opts.actor ?? null })
  await engine.resync()
  return { s, api, k, engine }
}

describe('A15 settling debits', () => {
  it('1: keeps the debit after the ack until a later pull', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    expect(shown(engine)).toBe(3)
    s.stock = 3
    await send(engine)
    expect(engine.outbox.pending()).toHaveLength(0)
    expect(shown(engine)).toBe(3) // today (without A15) this is 5
  })

  it('2: a pull sent after the ack retires the debit', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    await engine.resync()
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
  })

  it('3: a pull in flight across the ack does not retire it (documented residue)', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    const g = gate()
    s.pullPlans.push({ gate: g.p })
    const pull = engine.resync() // sent before the ack
    s.stock = 3
    await send(engine)
    g.open() // answers after the commit: snapshot already has the sale
    await pull
    expect(shown(engine)).toBe(1) // briefly LOW, never "reappears"
    await engine.resync()
    expect(shown(engine)).toBe(3)
  })

  it('4: a pull response older than the last applied one is ignored', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    const g = gate()
    s.pullPlans.push({ gate: g.p, stock: 5 }) // old read
    const slow = engine.resync()
    await engine.resync() // newer pull reads 3 and is applied first
    g.open()
    await slow
    expect(engine.getSnapshot().products?.[0]?.variants[0].stock).toBe(3) // not rolled back to 5
    expect(shown(engine)).toBe(3)
  })

  it('5: lost response, then pull, then duplicate ack: briefly low, never high, then exact', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.batchMode = 'lost'
    await send(engine)
    expect(shown(engine)).toBe(3) // still queued
    await engine.resync() // server already has the sale
    expect(shown(engine)).toBe(1) // accepted double count
    s.batchMode = 'ok'
    await send(engine) // duplicate ack
    expect(shown(engine)).toBe(1)
    await engine.resync()
    expect(shown(engine)).toBe(3)
  })

  it('6: a late retry after a retryable failure is counted once', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.batchMode = 'busy'
    await send(engine)
    expect(shown(engine)).toBe(3)
    s.batchMode = 'ok'
    s.stock = 3
    await send(engine)
    expect(shown(engine)).toBe(3)
    expect(engine.pendingStockDeltas()).toEqual({ [SKU]: 2 })
  })

  it('7: a parked sale keeps reducing stock until it is resolved or removed', async () => {
    const { s, engine } = await setup()
    const item = await engine.enqueue('order', order())
    s.batchMode = 'park'
    await send(engine)
    expect(engine.outbox.deadLettered()).toHaveLength(1)
    expect(shown(engine)).toBe(3)
    await engine.outbox.resolveReviewed([item.idempotencyKey])
    expect(shown(engine)).toBe(5)
  })

  it('8: survives an app restart between ack and pull', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    await engine.idle()
    const again = new SyncEngine(makeServer().api, {}, k.kv, { actor: null })
    expect(shown(again)).toBe(3)
  })

  it('9: a failed settle write leaves the item pending and does not double count', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    k.ctl.modeFor = (key) => (key === OUTBOX_KEY ? 'reject' : undefined)
    await send(engine)
    expect(engine.outbox.pending()).toHaveLength(1)
    expect(shown(engine)).toBe(3) // pending wins over the provisional entry
    k.ctl.modeFor = undefined
    await send(engine)
    expect(shown(engine)).toBe(3)
  })

  it('10: an acked order row left behind by a skipped prune is counted exactly once', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    await engine.enqueue('refund', { orderId: 'old1', reason: 'x' })
    s.stock = 3
    k.ctl.modeFor = (key) => (key === SYNCED_REFUNDS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await send(engine)
    expect(engine.outbox.all().some((i) => i.type === 'order' && i.status === 'acked')).toBe(true) // not pruned
    expect(shown(engine)).toBe(3)
  })

  it('11: drops a debit whose variant is missing from the new snapshot', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    const g = gate()
    s.pullPlans.push({ gate: g.p, omitProduct: true })
    const pull = engine.resync()
    await send(engine) // acked while the pull is in flight: survives retirement
    g.open()
    await pull
    expect(engine.pendingStockDeltas()).toEqual({})
  })

  it('12: counts only the current outlet (queued and settled orders)', async () => {
    let outlet = 'A'
    const { s, engine } = await setup({ actor: () => ({ outletId: outlet, userId: 'u1' }) })
    await engine.enqueue('order', order())
    outlet = 'B'
    expect(engine.pendingStockDeltas()).toEqual({})
    outlet = 'A'
    expect(engine.pendingStockDeltas()).toEqual({ [SKU]: 2 })
    s.stock = 3
    await send(engine)
    expect(engine.pendingStockDeltas()).toEqual({ [SKU]: 2 })
    outlet = 'B'
    expect(engine.pendingStockDeltas()).toEqual({})
  })

  it('13: the isolated per-item resend path stamps debits too', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    await engine.enqueue('order', order())
    s.batchMode = 'rejectMulti'
    await send(engine)
    expect(s.batches).toHaveLength(3) // one combined (refused), then one per item
    expect(engine.outbox.pending()).toHaveLength(0)
    expect(shown(engine)).toBe(1) // 5 - 2 - 2
  })

  it('persists the settling store through the engine KV', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    await engine.idle()
    expect(k.store.get(SETTLING_DEBITS_KEY)).toContain('"qty":2')
  })
})
