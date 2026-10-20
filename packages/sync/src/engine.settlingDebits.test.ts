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
    batchMode: 'ok' as 'ok' | 'duplicate' | 'lost' | 'busy' | 'park' | 'rejectMulti',
    batches: [] as string[][],
    resolved: [] as string[], // keys head office has resolved (answered by /sync/review-items)
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
    if (method === 'POST' && path.includes('/sync/review-items')) {
      return { data: { resolved: s.resolved.map((k) => ({ idempotencyKey: k, note: 'ok', resolvedByName: 'HO' })) } }
    }
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
        return { idempotencyKey: i.idempotencyKey, status: s.batchMode === 'duplicate' ? 'duplicate' : 'ok' }
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

  it('4: overlapping resyncs share one pull, so an older read can never land after a newer one', async () => {
    // Single-flight (auto-pull T1): the out-of-order guard is still unit-tested in settlingDebits.test.ts.
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    const g = gate()
    s.pullPlans.push({ gate: g.p, stock: 3 })
    const slow = engine.resync()
    const joined = engine.resync() // joins the in-flight pull instead of sending a second request
    g.open()
    await Promise.all([slow, joined])
    expect(engine.getSnapshot().products?.[0]?.variants[0].stock).toBe(3)
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

  it('7: a parked sale keeps reducing stock; once head office resolves it the debit stays until a later pull', async () => {
    const { s, engine } = await setup()
    const item = await engine.enqueue('order', order())
    s.batchMode = 'park'
    await send(engine)
    expect(engine.outbox.deadLettered()).toHaveLength(1)
    expect(shown(engine)).toBe(3)
    s.resolved = [item.idempotencyKey]
    vi.stubGlobal('navigator', { onLine: true })
    await engine.checkInReviews()
    vi.stubGlobal('navigator', { onLine: false })
    expect(engine.outbox.all()).toHaveLength(0)
    expect(shown(engine)).toBe(3) // never jumps back up (LOW at worst)
    await engine.resync() // the resolved sale never reached the server
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

  it('14: a failed pull leaves debits alone and the next pull retires them', async () => {
    const { s, engine } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    s.pullPlans.push({ gate: Promise.reject(new TypeError('network')) })
    await expect(engine.resync()).rejects.toThrow()
    expect(shown(engine)).toBe(3)
    await engine.resync()
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
  })

  it('15: a failed counter write does not break the pull', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    k.ctl.modeFor = (key) => (key === SETTLING_DEBITS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await engine.resync()
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
  })

  it('16: an order whose debit could not be stored is not acked or pruned in that batch', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    k.ctl.modeFor = (key) => (key === SETTLING_DEBITS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await send(engine)
    expect(engine.outbox.pending()).toHaveLength(1) // stays queued, still counted once
    expect(shown(engine)).toBe(3)
    k.ctl.modeFor = undefined
    s.batchMode = 'duplicate' // the backend answers a seen idempotency key with a duplicate status
    await send(engine)
    expect(engine.outbox.pending()).toHaveLength(0)
    expect(shown(engine)).toBe(3)
    expect(engine.pendingStockDeltas()).toEqual({ [SKU]: 2 })
  })

  it('17: an offline restart keeps an old debit', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    await send(engine)
    await engine.idle()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000)
      const again = new SyncEngine(makeServer().api, {}, k.kv, { actor: null })
      expect(shown(again)).toBe(3) // old snapshot (5) minus the kept debit
    } finally {
      vi.useRealTimers()
    }
  })

  it('18: replacing the engine mid-pull: the old pull cannot overwrite the new engine or touch its own state', async () => {
    const { k } = await setup()
    const onWall = vi.fn()
    const old = makeServer()
    const g = gate()
    old.s.pullPlans.push({ gate: g.p, stock: 99 })
    const hanging = new SyncEngine(old.api, { onWall }, k.kv, { actor: null })
    const stalePull = hanging.resync() // in flight
    await Promise.resolve()
    hanging.dispose()
    await hanging.idle()
    const fresh = makeServer()
    const next = new SyncEngine(fresh.api, {}, k.kv, { actor: null })
    await next.rehydrate()
    await next.resync()
    await next.enqueue('order', order())
    fresh.s.stock = 3
    await send(next)
    await next.idle()
    onWall.mockClear()
    const snapshotBefore = k.kv.get('mandalika.pos.snapshot')
    g.open()
    await stalePull
    await hanging.idle()
    expect(onWall).not.toHaveBeenCalled() // no wall update from the retired engine
    expect(k.kv.get('mandalika.pos.snapshot')).toBe(snapshotBefore) // no snapshot.replace
    const restarted = new SyncEngine(makeServer().api, {}, k.kv, { actor: null })
    expect(restarted.pendingStockDeltas()).toEqual({ [SKU]: 2 }) // the debit survived
  })

  it('19: a pull begun after dispose (dev StrictMode re-run, revived by start later) still applies', async () => {
    const { s, engine } = await setup()
    s.stock = 4
    engine.dispose()
    await engine.resync()
    expect(engine.getSnapshot().products?.[0]?.variants[0].stock).toBe(4)
  })

  it('20: a persistently failing settling write holds an order at most 3 times, then the queue drains', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    k.ctl.modeFor = (key) => (key === SETTLING_DEBITS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) {
      await send(engine)
      expect(engine.outbox.pending()).toHaveLength(1)
    }
    await send(engine)
    expect(engine.outbox.pending()).toHaveLength(0) // drained: the terminal can be released
    expect(shown(engine)).toBe(3) // the debit is still counted from memory
  })

  it('21: rehydrate during an in-flight settling write keeps the entry and counts the order once', async () => {
    const { s, engine, k } = await setup()
    await engine.enqueue('order', order())
    s.stock = 3
    k.ctl.modeFor = (key) => (key === SETTLING_DEBITS_KEY ? 'hold' : undefined)
    const flushing = send(engine)
    await vi.waitFor(() => expect(k.ctl.held.some((h) => h.key === SETTLING_DEBITS_KEY)).toBe(true))
    const rehydrating = engine.rehydrate()
    await new Promise((r) => setTimeout(r, 20)) // let a reload that does not wait for the write run first
    k.ctl.modeFor = undefined
    k.ctl.held.filter((h) => h.key === SETTLING_DEBITS_KEY).forEach((h) => h.resolve())
    await Promise.all([flushing, rehydrating])
    expect(shown(engine)).toBe(3)
    expect(engine.pendingStockDeltas()).toEqual({ [SKU]: 2 })
    await engine.idle()
    const restarted = new SyncEngine(makeServer().api, {}, k.kv, { actor: null })
    expect(restarted.pendingStockDeltas()).toEqual({ [SKU]: 2 })
  })
})
