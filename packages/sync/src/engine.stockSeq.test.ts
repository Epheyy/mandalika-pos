import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type WallState } from './engine'
import { JournalOutboxStore } from './journalOutboxStore'
import { createFakeJournal } from './testFixtures/fakeJournal'
import { controllableKV } from './testFixtures/controllableKV'
import { makeSeqServer } from './testFixtures/stockSeqServer'
import { PULLED_FOR_OUTLET_KEY } from './snapshot'
import { SETTLING_DEBITS_MAX } from './settlingDebits'

// A15 phase B: the outlet stock counter (`stockSeq`) lets a tablet notice stock changes made elsewhere and
// retire its own settling debits exactly. Every seq rule is off unless the snapshot was pulled for the current
// actor outlet AND the server sent a seq. Fake timers drive the 12 s poll; Math.random is pinned to 0, so
// jitter is its lower bound (5 s, nudge 2 s).

const POLL = 12_000
const STOCK_FLOOR = 300_000
const SKU = 'p1|10ml'

const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
// The fake journal answers on timers, so under fake time an awaited call needs the clock nudged along.
async function until<T>(p: Promise<T>): Promise<T> {
  let done = false
  void p.then(() => { done = true }, () => { done = true })
  while (!done) await advance(1)
  return p
}
function gate() {
  let open!: () => void
  const p = new Promise<void>((r) => { open = r })
  return { p, open }
}

const stockOf = (e: SyncEngine) => e.getSnapshot().products?.[0]?.variants[0].stock ?? null
const shown = (e: SyncEngine) => {
  const st = stockOf(e)
  return st === null ? null : st - (e.pendingStockDeltas()[SKU] ?? 0)
}
const order = (qty = 2) => ({ items: [{ productId: 'p1', variantSize: '10ml', quantity: qty }] })
type Peek = { settling: { list(): { key: string; seq?: number; seqOutlet?: string }[]; recordMany(e: unknown[]): Promise<void> }; autoPull: { armedKind(): string | null } }
const peek = (e: SyncEngine) => e as unknown as Peek

// Queue a sale without the enqueue-time flush (navigator offline just for the write).
async function queue(e: SyncEngine, qty = 2) {
  online(false)
  try { return await until(e.enqueue('order', order(qty))) } finally { online(true) }
}

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

interface SetupOpts { withSeq?: boolean; noActor?: boolean; flushOnly?: boolean; noGate?: boolean }

async function setup(storeKind: 'kv' | 'journal', opts: SetupOpts = {}) {
  const { s, api } = makeSeqServer({ withSeq: opts.withSeq })
  const prefs = controllableKV()
  const outboxStore = storeKind === 'journal' ? await JournalOutboxStore.open(createFakeJournal().plugin, prefs.kv) : undefined
  const walls: WallState[] = []
  const actor = { outlet: 'A' }
  const engine = new SyncEngine(api, { onWall: (w) => walls.push(w) }, prefs.kv, {
    actor: opts.noActor ? null : () => ({ outletId: actor.outlet, userId: 'u1' }),
    outboxStore,
  })
  await until(engine.resync()) // boot pull: binds the snapshot to outlet A at seq 10
  const gateState = { open: true }
  if (!opts.noGate) engine.setAutoPullGate(() => gateState.open)
  const stop = engine.start(POLL, { flushOnly: opts.flushOnly })
  s.pulls = 0
  s.pullTimes.length = 0
  return { s, engine, stop, walls, actor, gateState, kv: prefs }
}

describe.each(['kv', 'journal'] as const)('A15 phase B stock seq over the %s store', (kind) => {
  it('ack-then-pull: a pull after the sale retires the debit and stock is exact', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    await until(engine.flushNow())
    expect(peek(engine).settling.list()).toMatchObject([{ seq: 11, seqOutlet: 'A' }])
    expect(shown(engine)).toBe(3)
    await until(engine.resync())
    expect(engine.pendingStockDeltas()).toEqual({})
    expect(shown(engine)).toBe(3)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1) // nothing further: the sale was explained, the pull covered it
  })

  it('pull-applied-then-ack retires on record', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    const g = gate()
    s.batchGate = g.p
    const flushing = engine.flushNow() // the server commits (seq 11), the response is held
    await advance(1)
    await until(engine.resync()) // pulls seq 11 with the sale in it, before the ack arrives
    expect(shown(engine)).toBe(1) // item still queued: counted on top of the pulled stock (briefly LOW)
    s.batchGate = null
    g.open()
    await until(flushing)
    expect(peek(engine).settling.list()).toEqual([]) // the snapshot already covers seq 11: nothing to bridge
    expect(shown(engine)).toBe(3)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('in-flight pull exact by seq: no residue, no follow-up pull', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    const g1 = gate()
    s.batchGate = g1.p
    const flushing = engine.flushNow() // committed at seq 11, response held
    await advance(1)
    const g2 = gate()
    s.pullGate = g2.p
    const pull = engine.resync() // read seq 11 and the new stock, response held
    await advance(1)
    s.batchGate = null
    g1.open()
    await until(flushing) // acked while the pull is in flight: entry with seq 11 recorded
    expect(peek(engine).settling.list()).toHaveLength(1)
    s.pullGate = null
    g2.open()
    await until(pull)
    expect(peek(engine).settling.list()).toEqual([]) // retired by seq although the pull was sent before the ack
    expect(shown(engine)).toBe(3)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1) // today's gen rule would keep it and pull again
  })

  it('seq-less duplicate requests one follow-up pull', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    s.batchMode = 'lost'
    await until(engine.flushNow()) // committed, response lost
    await until(engine.resync()) // the pull has the sale; the item is still queued
    expect(shown(engine)).toBe(1) // accepted double count
    s.batchMode = 'duplicate'
    await until(engine.flushNow()) // duplicate ack: no item seq, the batch has one
    expect(shown(engine)).toBe(1)
    const before = s.pulls
    await advance(5_000)
    expect(s.pulls).toBe(before + 1)
    expect(shown(engine)).toBe(3)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(before + 1)
  })

  it('resolved review item requests one follow-up pull', async () => {
    const { s, engine } = await setup(kind)
    const item = await queue(engine, 2)
    s.batchMode = 'park'
    s.resolved = [item.idempotencyKey] // head office answers the check-in that the flush itself triggers
    await until(engine.flushNow())
    await advance(100)
    expect(engine.outbox.all()).toHaveLength(0)
    expect(shown(engine)).toBe(3) // the debit stays (LOW at worst) ...
    await advance(5_000)
    expect(s.pulls).toBe(1)
    expect(shown(engine)).toBe(5) // ... until the pull: the resolved sale never reached the server
  })

  it('stock-only drift pulls once and never raises the update chip; own sales do not pull', async () => {
    const { s, engine, walls } = await setup(kind)
    s.foreignSale(2) // another tablet sold: seq 11, stock 3, version unchanged
    await advance(POLL) // the poll sees it
    expect(s.pulls).toBe(0)
    await advance(5_000)
    expect(s.pulls).toBe(1)
    expect(stockOf(engine)).toBe(3)
    expect(walls.some((w) => w.raised)).toBe(false)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('F19 stockRefreshPending: true from the poll that sees foreign drift until the throttled pull lands; own sales never', async () => {
    const { s, engine } = await setup(kind)
    expect(engine.stockRefreshPending()).toBe(false)
    await queue(engine, 1)
    await until(engine.flushNow())
    await advance(POLL)
    expect(engine.stockRefreshPending()).toBe(false) // an own, explained bump is not drift
    s.foreignSale(1)
    await advance(POLL)
    expect(engine.stockRefreshPending()).toBe(true)
    await advance(5_000 + STOCK_FLOOR)
    expect(s.pulls).toBe(1)
    expect(engine.stockRefreshPending()).toBe(false)
  })

  it('F19 stockRefreshPending stays true while the gate defers the pull, and a manual resync clears it', async () => {
    const { s, engine, gateState } = await setup(kind)
    gateState.open = false
    s.foreignSale(1)
    await advance(POLL + 10 * 60_000)
    expect(s.pulls).toBe(0)
    expect(engine.stockRefreshPending()).toBe(true)
    await until(engine.resync())
    expect(engine.stockRefreshPending()).toBe(false)
  })

  it('F19 stockRefreshPending is false while the data wall is raised and for housekeeping alone', async () => {
    const { s, engine } = await setup(kind)
    s.version = 2
    s.foreignSale(1)
    await advance(POLL)
    expect(engine.getWall().raised).toBe(true)
    expect(engine.stockRefreshPending()).toBe(false)
    await until(engine.resync())
    const lines = [{ productId: 'p1', variantSize: '10ml', qty: 1 }]
    await peek(engine).settling.recordMany(Array.from({ length: 200 }, (_, i) => ({ key: `h${i}`, lines })))
    expect(engine.stockRefreshPending()).toBe(false)
  })

  it('F19 stockRefreshPending is false on a server without seq', async () => {
    const { s, engine } = await setup(kind, { withSeq: false })
    s.foreignSale(1)
    await advance(POLL)
    expect(engine.stockRefreshPending()).toBe(false)
  })

  it('a refund (seq moves, no entry explains it) pulls the restock', async () => {
    const { s, engine } = await setup(kind)
    s.refund(1)
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    expect(stockOf(engine)).toBe(6)
  })

  it('50 own sales cause zero stock pulls', async () => {
    const { s, engine } = await setup(kind)
    for (let i = 0; i < 50; i++) {
      await queue(engine, 1)
      await until(engine.flushNow())
      await advance(POLL)
    }
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
    expect(peek(engine).settling.list()).toHaveLength(50)
  })

  it('50 foreign bumps cause at most one pull per 5 minutes', async () => {
    const { s } = await setup(kind)
    for (let i = 0; i < 50; i++) {
      s.foreignSale(1)
      await advance(POLL)
    }
    expect(s.pulls).toBeGreaterThanOrEqual(1)
    expect(s.pulls).toBeLessThanOrEqual(2) // 600 s: one per 300 s
    for (let i = 1; i < s.pullTimes.length; i++) expect(s.pullTimes[i] - s.pullTimes[i - 1]).toBeGreaterThanOrEqual(STOCK_FLOOR)
  })

  it('own sales interleaved with foreign bumps still pull only for the foreign ones', async () => {
    const { s, engine } = await setup(kind)
    for (let i = 0; i < 10; i++) {
      await queue(engine, 1)
      await until(engine.flushNow())
      await advance(POLL)
    }
    expect(s.pulls).toBe(0)
    s.foreignSale(1)
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    expect(shown(engine)).toBe(5 - 10 - 1)
  })

  it('poll-vs-ack race: a poll between the server commit and the ack costs zero pulls', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    const g = gate()
    s.batchGate = g.p
    const flushing = engine.flushNow() // committed at seq 11, response held
    await advance(POLL + 20_000) // the poll lands inside the window and looks like foreign drift; the timer fires meanwhile
    expect(s.pulls).toBe(0) // never while the flush is running
    s.batchGate = null
    g.open()
    await until(flushing) // the ack explains seq 11
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  it('old server (no seq anywhere) behaves like Phase A: no stock pulls, follow-up stays on the data budget', async () => {
    const { s, engine } = await setup(kind, { withSeq: false })
    s.foreignSale(2)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
    expect(stockOf(engine)).toBe(5)
    // pull in flight across an own ack: the follow-up is armed as a 'data' pull (60 s floor, 20/h budget)
    await queue(engine, 2)
    const g1 = gate()
    s.batchGate = g1.p
    const flushing = engine.flushNow()
    await advance(1)
    const g2 = gate()
    s.pullGate = g2.p
    const pull = engine.resync()
    await advance(1)
    s.batchGate = null
    g1.open()
    await until(flushing)
    s.pullGate = null
    g2.open()
    await until(pull)
    expect(peek(engine).autoPull.armedKind()).toBe('data')
  })

  it('with the rules on, the follow-up after an in-flight pull is a stock pull', async () => {
    const { s, engine } = await setup(kind)
    await queue(engine, 2)
    const g2 = gate()
    s.pullGate = g2.p
    const pull = engine.resync() // read seq 10: sent before the sale
    await advance(1)
    await until(engine.flushNow()) // sale commits (seq 11) and acks while the pull is in flight
    s.pullGate = null
    g2.open()
    await until(pull)
    expect(peek(engine).settling.list()).toHaveLength(1) // the pull's seq 10 is below the sale's 11
    expect(peek(engine).autoPull.armedKind()).toBe('stock')
  })

  it('seq everywhere but the rules forced off (no actor outlet) pulls and shows exactly like a no-seq server', async () => {
    const withSeq = await setup(kind, { noActor: true })
    withSeq.s.foreignSale(2)
    await queue(withSeq.engine, 1)
    await until(withSeq.engine.flushNow())
    await advance(10 * 60_000)
    expect(withSeq.s.pulls).toBe(0)
    expect(peek(withSeq.engine).settling.list().every((e) => e.seq === undefined)).toBe(true)
    withSeq.stop()
    const none = await setup(kind, { withSeq: false, noActor: true })
    none.s.foreignSale(2)
    await queue(none.engine, 1)
    await until(none.engine.flushNow())
    await advance(10 * 60_000)
    expect(none.s.pulls).toBe(0)
    expect(shown(withSeq.engine)).toBe(shown(none.engine))
  })

  it('an outlet switch is a mismatch: one pull rebinds, then quiet', async () => {
    const { s, actor, kv } = await setup(kind)
    actor.outlet = 'B'
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    expect(kv.store.get(PULLED_FOR_OUTLET_KEY)).toBe('B')
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('an entry of another outlet never retires by seq and an order attributed elsewhere gets no seq or follow-up', async () => {
    const { s, engine, actor } = await setup(kind)
    actor.outlet = 'B'
    await queue(engine, 2) // captured for outlet B
    actor.outlet = 'A'
    s.otherOutlet = true // acked ok, but it is not this outlet's stock
    await until(engine.flushNow())
    expect(peek(engine).settling.list().every((e) => e.seq === undefined)).toBe(true)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  it('flush-only never pulls; a closed gate holds the stock pull until a nudge; offline pulls nothing', async () => {
    const f = await setup(kind, { flushOnly: true })
    f.s.foreignSale(1)
    await advance(10 * 60_000)
    expect(f.s.pulls).toBe(0)
    f.stop()

    const g = await setup(kind)
    g.gateState.open = false
    g.s.foreignSale(1)
    await advance(10 * 60_000)
    expect(g.s.pulls).toBe(0)
    g.gateState.open = true
    g.engine.nudgeAutoPull()
    await advance(2_000)
    expect(g.s.pulls).toBe(1)
    g.stop()

    const o = await setup(kind)
    o.s.foreignSale(1)
    await advance(POLL)
    online(false)
    await advance(10 * 60_000)
    expect(o.s.pulls).toBe(0)
  })

  it('a database restore (server seq below the local one) pulls once, stamps no seq meanwhile, and goes quiet', async () => {
    const { s, engine } = await setup(kind)
    s.seq = 3 // restored from a backup
    await advance(POLL) // the poll sees seq 3 < 10
    await queue(engine, 1)
    await until(engine.flushNow()) // acked inside the regression window: its seq (4) is in the new space
    expect(peek(engine).settling.list().every((e) => e.seq === undefined)).toBe(true)
    await advance(5_000)
    expect(s.pulls).toBe(1)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('housekeeping: 200 settling entries trigger one stock pull that retires them', async () => {
    const { s, engine } = await setup(kind)
    const lines = [{ productId: 'p1', variantSize: '10ml', qty: 1 }]
    await peek(engine).settling.recordMany(Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, lines })))
    expect(SETTLING_DEBITS_MAX).toBeGreaterThan(200)
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    expect(peek(engine).settling.list()).toEqual([])
  })

  it('a sale with no debit lines (bundle only) still counts as an explained bump', async () => {
    const { s, engine } = await setup(kind)
    online(false)
    try { await until(engine.enqueue('order', { items: [{ bundleId: 'b1', quantity: 1 }] })) } finally { online(true) }
    await until(engine.flushNow())
    expect(peek(engine).settling.list()).toMatchObject([{ seq: 11, lines: [] }])
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
    await until(engine.resync()) // a pull that does not cover a later seq must keep the empty entry counted
    expect(s.pulls).toBe(1)
  })

  it('kill switch mid-session: seq vanishes, rules go off (no pulls, no stamps); it returns, one pull rebinds', async () => {
    const { s, engine } = await setup(kind)
    s.withSeq = false
    s.foreignSale(1)
    await advance(POLL)
    await queue(engine, 1)
    await until(engine.flushNow())
    expect(peek(engine).settling.list().every((e) => e.seq === undefined)).toBe(true)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
    s.withSeq = true
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
    expect(engine.getSnapshot().stockSeq).toBe(s.seq)
  })

  it('a restore first seen in a BATCH response keeps the debit and pulls once', async () => {
    const { s, engine } = await setup(kind)
    s.seq = 105
    await until(engine.resync()) // local seq 105
    s.pulls = 0
    s.seq = 50 // database restored; no poll has seen it yet
    await queue(engine, 2)
    await until(engine.flushNow()) // item seq 51 <= 105: must not be taken as "already in the snapshot"
    expect(peek(engine).settling.list()).toMatchObject([{ lines: [{ qty: 2 }] }])
    expect(peek(engine).settling.list()[0].seq).toBeUndefined()
    expect(engine.pendingStockDeltas()[SKU]).toBe(2)
    await advance(5_000)
    expect(s.pulls).toBe(1)
    expect(engine.pendingStockDeltas()).toEqual({})
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('a restore landing exactly at local-1 (item seq == local) keeps the debit and pulls once', async () => {
    const { s, engine } = await setup(kind)
    s.seq = 105
    await until(engine.resync())
    s.pulls = 0
    s.seq = 104
    await queue(engine, 2)
    await until(engine.flushNow()) // item seq 105 == local: a fresh commit is always above the seq read before the post
    expect(peek(engine).settling.list()).toHaveLength(1)
    expect(peek(engine).settling.list()[0].seq).toBeUndefined()
    await advance(5_000)
    expect(s.pulls).toBe(1)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })

  it('a pull applied between the post and its response cannot mask a restore', async () => {
    const { s, engine } = await setup(kind)
    s.seq = 105
    await until(engine.resync())
    s.pulls = 0
    const g2 = gate()
    s.pullGate = g2.p
    const pull = engine.resync() // reads seq 105 on the pre-restore database; response held
    await advance(1)
    s.pullGate = null
    s.seq = 50 // restored
    await queue(engine, 2)
    const g1 = gate()
    s.batchGate = g1.p
    const flushing = engine.flushNow() // commits at 51, response held
    await advance(1)
    g2.open()
    await until(pull) // the old-space bundle (seq 105) is applied before the response
    s.batchGate = null
    g1.open()
    await until(flushing)
    expect(peek(engine).settling.list()).toHaveLength(1) // kept, not skipped as "covered"
    expect(peek(engine).settling.list()[0].seq).toBeUndefined()
    await advance(5_000)
    expect(s.pulls).toBe(2) // the held pull plus one stock pull
    await advance(10 * 60_000)
    expect(s.pulls).toBe(2)
  })

  it('a batch posted for outlet B is not compared with outlet A counter after a switch', async () => {
    const { s, engine, actor } = await setup(kind)
    actor.outlet = 'B'
    await queue(engine, 1)
    const g1 = gate()
    s.batchGate = g1.p
    const flushing = engine.flushNow() // posted as B, commits at seq 11
    await advance(1)
    actor.outlet = 'A'
    s.seq = 200 // outlet A's own counter
    await until(engine.resync()) // binds A at 200
    s.pulls = 0
    s.batchGate = null
    g1.open()
    await until(flushing) // response seq 11 belongs to B: no regression, no stamp
    expect(peek(engine).settling.list().every((e) => e.seq === undefined)).toBe(true)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(0)
  })

  // Note: this also passes without the explicit markWaiting(kind), because afterWallUpdate re-marks the kind at the
  // end of every run. It guards the observable behaviour (a nudge re-arms under the stock kind), not that line.
  it('a deferred stock pull waits as a stock pull and a nudge re-arms it under the stock kind', async () => {
    const { s, engine, gateState } = await setup(kind)
    s.foreignSale(1)
    const g = gate()
    s.pullGate = g.p
    await advance(POLL + 5_000) // the stock pull is in flight
    expect(s.pulls).toBe(1)
    gateState.open = false // cashier adds an item meanwhile
    s.pullGate = null
    g.open()
    await advance(1)
    expect(stockOf(engine)).toBe(5) // deferred: nothing applied
    gateState.open = true
    engine.nudgeAutoPull()
    expect(peek(engine).autoPull.armedKind()).toBe('stock')
  })

  it('a raised wall with the data budget spent still lets pending stock drift get its own stock pull', async () => {
    const { s, engine } = await setup(kind)
    const sched = peek(engine).autoPull as unknown as { attemptStarted(k: string): void }
    for (let i = 0; i < 20; i++) sched.attemptStarted('data') // data cap used up
    s.version = 2
    s.foreignSale(2)
    await advance(POLL + 5_000)
    expect(engine.getWall().raised).toBe(true) // the chip stays
    expect(peek(engine).autoPull.armedKind()).toBe('stock')
    await advance(STOCK_FLOOR + 5_000)
    expect(s.pulls).toBe(1)
    expect(stockOf(engine)).toBe(3)
  })

  it('upgrade: an old-server snapshot has no binding, the first seq from the server causes exactly one pull', async () => {
    const { s, engine, kv } = await setup(kind, { withSeq: false })
    expect(kv.store.get(PULLED_FOR_OUTLET_KEY)).toBeUndefined()
    s.withSeq = true
    await advance(POLL + 5_000)
    expect(s.pulls).toBe(1)
    expect(kv.store.get(PULLED_FOR_OUTLET_KEY)).toBe('A')
    expect(engine.getSnapshot().stockSeq).toBe(10)
    await advance(10 * 60_000)
    expect(s.pulls).toBe(1)
  })
})
