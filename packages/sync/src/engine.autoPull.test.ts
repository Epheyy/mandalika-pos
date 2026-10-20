import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike, type WallState } from './engine'
import { JournalOutboxStore } from './journalOutboxStore'
import { createFakeJournal } from './testFixtures/fakeJournal'
import { controllableKV } from './testFixtures/controllableKV'

// Auto-pull T3: the engine pulls reference data by itself, but only when it is safe (see the plan).
// Fake timers drive the 12 s poll; Math.random is pinned so jitter is the lower bound (5 s / 2 s).

const POLL = 12_000

function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { p, open }
}

function makeServer() {
  const s = {
    version: 1,
    stock: 5,
    pulls: 0,
    pullGate: null as Promise<void> | null,
    pullFail: null as { status: number } | null,
    batchGate: null as Promise<void> | null,
    batchFail: false,
  }
  const request = vi.fn(async (method: string, path: string, body?: { items: { idempotencyKey: string }[] }) => {
    if (method === 'GET' && path.includes('/sync/pull')) {
      s.pulls += 1
      const g = s.pullGate
      const version = s.version
      const stock = s.stock
      if (g) await g
      if (s.pullFail) throw Object.assign(new Error('pull failed'), { status: s.pullFail.status, kind: 'http' })
      return {
        data: {
          version,
          products: [{ id: 'p1', name: 'A', isActive: true, variants: [{ size: '10ml', price: 1, stock, sku: '' }] }],
          categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [],
        },
      }
    }
    if (method === 'GET' && path.includes('/sync/version')) return { data: { version: s.version } }
    if (method === 'GET' && path.includes('/sync/inbound')) return { data: [] }
    if (method === 'POST' && path.includes('/sync/review-items')) return { data: { resolved: [] } }
    if (method === 'POST' && path.includes('/sync/batch') && body) {
      if (s.batchGate) await s.batchGate
      if (s.batchFail) throw Object.assign(new Error('busy'), { status: 503, kind: 'http' })
      return {
        data: {
          processed: body.items.length,
          version: s.version,
          results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })),
        },
      }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { s, api: { request: request as unknown as ApiLike['request'] } as ApiLike }
}

const SKU = 'p1|10ml'
const stockOf = (e: SyncEngine) => e.getSnapshot().products?.[0]?.variants[0].stock ?? null
const shown = (e: SyncEngine) => {
  const st = stockOf(e)
  return st === null ? null : st - (e.pendingStockDeltas()[SKU] ?? 0)
}
const order = (qty = 2) => ({ items: [{ productId: 'p1', variantSize: '10ml', quantity: qty }] })
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
// Queue a sale without the enqueue-time flush (navigator offline just for the write).
async function queue(e: SyncEngine, qty = 2) {
  online(false)
  try { await until(e.enqueue('order', order(qty))) } finally { online(true) }
}
// The fake journal answers on timers, so under fake time an awaited call needs the clock nudged along.
async function until<T>(p: Promise<T>): Promise<T> {
  let done = false
  void p.then(() => { done = true }, () => { done = true })
  while (!done) await advance(1)
  return p
}
// Test-only peek at the settling counters (no public accessor on purpose).
const applied = (e: SyncEngine) => (e as unknown as { settling: { state: { applied: number } } }).settling.state.applied
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  online(true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(storeKind: 'kv' | 'journal', opts: { gateOpen?: () => boolean; noGate?: boolean; flushOnly?: boolean; onWall?: (w: WallState) => void } = {}) {
  const { s, api } = makeServer()
  const prefs = controllableKV().kv
  const outboxStore = storeKind === 'journal' ? await JournalOutboxStore.open(createFakeJournal().plugin, prefs) : undefined
  const engine = new SyncEngine(api, { onWall: opts.onWall }, prefs, { actor: null, outboxStore })
  await engine.resync() // boot pull at version 1
  const gateState = { open: true }
  if (!opts.noGate) engine.setAutoPullGate(opts.gateOpen ?? (() => gateState.open))
  const stop = engine.start(POLL, { flushOnly: opts.flushOnly })
  s.pulls = 0 // count only what happens after boot
  return { s, engine, stop, gateState }
}

describe.each(['kv', 'journal'] as const)('engine auto-pull over the %s store', (kind) => {
  it('a wall raised by the poll triggers one pull inside the jitter window and clears the chip', async () => {
    const { s, engine } = await setup(kind)
    s.version = 2
    s.stock = 9
    await advance(POLL - 1)
    expect(s.pulls).toBe(0)
    await advance(1) // poll sees the bump
    expect(engine.getWall().raised).toBe(true)
    await advance(4_999)
    expect(s.pulls).toBe(0)
    await advance(1)
    expect(s.pulls).toBe(1)
    expect(engine.getWall().raised).toBe(false)
    expect(engine.referenceVersion()).toBe(2)
    expect(stockOf(engine)).toBe(9)
    expect(engine.lastPulledAt()).toBe(Date.now())
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('a wall raised only by a batch ack (own transfer receive) also triggers a pull', async () => {
    const { s, engine } = await setup(kind)
    s.version = 2 // bumped by this tablet\'s own receive; the poll has not seen it yet
    await queue(engine)
    await until(engine.flushNow())
    expect(engine.getWall().raised).toBe(true)
    await advance(5_000)
    expect(s.pulls).toBe(1)
    expect(engine.getWall().raised).toBe(false)
  })

  it('offline: a pending pull is dropped and nothing is sent', async () => {
    const { s } = await setup(kind)
    s.version = 2
    await advance(POLL)
    online(false)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  it('no gate registered means deny: zero pulls', async () => {
    const { s, engine } = await setup(kind, { noGate: true })
    s.version = 2
    await advance(10 * 60_000)
    expect(engine.getWall().raised).toBe(true)
    expect(s.pulls).toBe(0)
  })

  it('flushOnly mode never auto-pulls even with a gate', async () => {
    const { s, engine } = await setup(kind, { flushOnly: true })
    s.version = 2
    await advance(10 * 60_000)
    expect(engine.getWall().raised).toBe(true)
    expect(s.pulls).toBe(0)
  })

  it('a busy gate holds the pull (no spin) and a nudge after idle pulls within 2-5 s', async () => {
    const { s, engine, gateState } = await setup(kind)
    gateState.open = false
    s.version = 2
    await advance(5 * 60_000)
    expect(s.pulls).toBe(0)
    expect(engine.getWall().raised).toBe(true)
    gateState.open = true
    engine.nudgeAutoPull()
    await advance(1_999)
    expect(s.pulls).toBe(0)
    await advance(1)
    expect(s.pulls).toBe(1)
    expect(engine.getWall().raised).toBe(false)
  })

  it('the gate is re-checked after the response: busy then means deferred, nothing changes', async () => {
    const { s, engine, gateState } = await setup(kind)
    s.version = 2
    s.stock = 9
    const g = gate()
    s.pullGate = g.p
    const appliedBefore = applied(engine)
    const snapBefore = engine.getSnapshot()
    const creditsBefore = engine.pending.list()
    await advance(POLL + 5_000) // request is now in flight
    expect(s.pulls).toBe(1)
    expect(engine.isPulling()).toBe(true)
    gateState.open = false // cashier adds an item while it is in flight
    g.open()
    await advance(1)
    expect(engine.isPulling()).toBe(false)
    expect(engine.referenceVersion()).toBe(1)
    expect(stockOf(engine)).toBe(5)
    expect(engine.getWall().raised).toBe(true)
    expect(applied(engine)).toBe(appliedBefore) // settling counters untouched by the discarded response
    expect(engine.getSnapshot()).toBe(snapBefore)
    expect(engine.pending.list()).toEqual(creditsBefore)
    s.pullGate = null
    gateState.open = true
    engine.nudgeAutoPull()
    await advance(60_000) // the 60 s floor from the first attempt still applies
    expect(s.pulls).toBe(2)
    expect(stockOf(engine)).toBe(9)
  })

  it('a manual resync joining a deferred auto pull still applies', async () => {
    const { s, engine, gateState } = await setup(kind)
    s.version = 2
    s.stock = 9
    const g = gate()
    s.pullGate = g.p
    await advance(POLL + 5_000)
    gateState.open = false
    const manual = engine.resync()
    g.open()
    s.pullGate = null
    await expect(manual).resolves.toBe('applied')
    expect(stockOf(engine)).toBe(9)
    expect(s.pulls).toBe(2)
  })

  it('does not pull while a flush is running; pulls after it ends', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine)
    s.version = 2
    const bg = gate()
    s.batchGate = bg.p
    const flushing = engine.flushNow() // sits in the batch request: flushing = true
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(0)
    await advance(30_000)
    expect(s.pulls).toBe(0)
    s.batchGate = null
    bg.open()
    await until(flushing)
    await advance(10_000)
    expect(s.pulls).toBe(1)
  })

  it('A15: sell, ack, auto-pull keeps stock exact and retires the settling debit', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    expect(shown(engine)).toBe(3)
    s.stock = 3
    s.version = 2
    await until(engine.flushNow()) // ack raises the wall; debit is kept (display stays 3)
    expect(shown(engine)).toBe(3)
    for (let i = 0; i < 20; i++) {
      await advance(1_000)
      const v = shown(engine)
      expect(v === null || v <= 3).toBe(true) // never above N-2
    }
    expect(s.pulls).toBe(1)
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
  })

  it('M1: an order acked inside a pull window is not left double-counted; one follow-up pull converges', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    s.batchFail = true // the poll-tick flush fails, so the ack can land inside the pull window
    s.version = 2
    s.stock = 3 // the server already holds the sale
    const g = gate()
    s.pullGate = g.p
    await advance(POLL + 5_000) // pull in flight: reads stock 3
    expect(s.pulls).toBe(1)
    s.pullGate = null
    s.batchFail = false
    await until(engine.flushNow()) // the ack lands while that pull is in flight: debit kept (gen >= pull number)
    g.open()
    await advance(1)
    expect(stockOf(engine)).toBe(3)
    expect(shown(engine)).toBe(1) // the transient: pulled value already had the sale, the kept debit subtracts again
    await advance(5 * 60_000) // one follow-up pull (60 s floor), not a loop
    expect(s.pulls).toBe(2)
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
  })

  it('M1: no follow-up when the pull retired every settling debit', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    s.stock = 3
    s.version = 2
    await until(engine.flushNow()) // ack first, pull afterwards: the pull is sent after the ack and retires it
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
    expect(shown(engine)).toBe(3)
  })

  it('a credit acked during a pull is kept by it and heals, without double counting, at the next auto-pull', async () => {
    const { s, engine } = await setup(kind)
    engine.pending.add({ idempotencyKey: 'k1', lines: [{ productId: 'p1', variantSize: '10ml', qty: 2 }], ackVersion: null })
    s.version = 2
    s.stock = 5 // what this pull reads: the receive has not committed yet
    const g = gate()
    s.pullGate = g.p
    await advance(POLL + 5_000) // pull in flight at version 2
    expect(s.pulls).toBe(1)
    engine.pending.stampAck('k1', 3) // the receive acks while the pull is in flight
    s.version = 3
    s.stock = 7 // now includes the receive
    s.pullGate = null
    g.open()
    await advance(1)
    expect(engine.referenceVersion()).toBe(2)
    expect(stockOf(engine)).toBe(7) // 5 pulled + 2 credit: high never, exact
    expect(engine.pending.list()).toHaveLength(1) // ackVersion 3 > pulled 2: kept
    await advance(2 * 60_000) // poll sees 3; the next auto-pull follows the 60 s floor
    expect(s.pulls).toBe(2)
    expect(engine.referenceVersion()).toBe(3)
    expect(engine.pending.list()).toHaveLength(0)
    expect(stockOf(engine)).toBe(7) // 7 pulled, credit retired: not 9
  })

  it('a failing pull backs off instead of looping', async () => {
    const { s } = await setup(kind)
    s.version = 2
    s.pullFail = { status: 500 }
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    await advance(14_000) // below the 15 s minimum backoff (30 s x 50%)
    expect(s.pulls).toBe(1)
    await advance(10 * 60_000)
    expect(s.pulls).toBeGreaterThan(1)
    expect(s.pulls).toBeLessThanOrEqual(8) // 60 s floor and backoff bound the rate
  })

  it('autoPullAvailable is false without a gate, in flushOnly, and after a 4xx; true otherwise', async () => {
    expect((await setup(kind, { noGate: true })).engine.autoPullAvailable()).toBe(false)
    expect((await setup(kind, { flushOnly: true })).engine.autoPullAvailable()).toBe(false)
    const { s, engine } = await setup(kind)
    expect(engine.autoPullAvailable()).toBe(true)
    s.version = 2
    s.pullFail = { status: 403 }
    await advance(POLL + 5_000)
    expect(engine.autoPullAvailable()).toBe(false)
  })

  it('a 4xx on the pull suspends auto-pull until a later version 2xx, then respects the floor', async () => {
    const { s, engine } = await setup(kind)
    s.version = 2
    s.pullFail = { status: 403 }
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    s.pullFail = null
    await advance(POLL - 6_000) // before the next poll: still suspended
    expect(s.pulls).toBe(1)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(2) // resumed by the poll's 2xx, spaced by the 60 s floor
    expect(engine.getWall().raised).toBe(false)
  })

  it('storm: 50 version bumps in 10 minutes produce at most 10 pulls', async () => {
    const { s } = await setup(kind)
    for (let i = 0; i < 50; i++) {
      s.version += 1
      await advance(POLL)
    }
    expect(s.pulls).toBeGreaterThan(0)
    expect(s.pulls).toBeLessThanOrEqual(10)
  })

  it('dispose mid-wait never pulls', async () => {
    const { s, engine } = await setup(kind)
    s.version = 2
    await advance(POLL + 1_000) // armed, not yet fired
    engine.dispose()
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  it('stop() cancels a pending pull', async () => {
    const { s, stop } = await setup(kind)
    s.version = 2
    await advance(POLL + 1_000)
    stop()
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  it('the swap is one synchronous block: when onWall reports the new version the snapshot is already new', async () => {
    const seen: { wallVersion: number; ref: number; stock: number | null }[] = []
    let engineRef: SyncEngine | null = null
    const { s, engine } = await setup(kind, {
      onWall: (w) => {
        if (engineRef && !w.raised) seen.push({ wallVersion: w.localVersion, ref: engineRef.referenceVersion(), stock: stockOf(engineRef) })
      },
    })
    engineRef = engine
    s.version = 2
    s.stock = 9
    await advance(POLL + 5_000)
    expect(seen.at(-1)).toEqual({ wallVersion: 2, ref: 2, stock: 9 })
  })
})
