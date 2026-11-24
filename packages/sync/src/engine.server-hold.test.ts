import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// A29 client half: the server's Retry-After (a 429/503 hold) outlives every manual retry path, and a
// whole-queue transient failure never flushes, polls or pulls before it ends. Math.random is pinned to 0,
// so the jitter is 0 and the hold is exactly the requested pause.

const POLL = 12_000
const BUSY = (retryAfterMs?: number) => Object.assign(new Error('busy'), { status: 503, kind: 'http', retryAfterMs })

type Body = { items: { type: string; idempotencyKey: string }[] }
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
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

function make(handler: (method: string, path: string, body?: Body) => unknown, opts: { probeHost?: () => Promise<boolean> } = {}) {
  const request = vi.fn(async (method: string, path: string, body?: Body) => handler(method, path, body))
  const engine = new SyncEngine({ request } as unknown as ApiLike, {}, controllableKV().kv, { actor: null, ...opts })
  const calls = (needle: string) => request.mock.calls.filter(([, p]) => (p as string).includes(needle)).length
  return { engine, request, calls }
}

const ok = (body?: Body) => ({
  data: { processed: body?.items.length ?? 0, version: 0, results: (body?.items ?? []).map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })) },
})

const contactOf = (e: SyncEngine) => (e as unknown as { contacts: { record(): unknown } }).contacts.record()

async function queueOrder(engine: SyncEngine) {
  online(false)
  try { await engine.enqueue('order', { total: 1 }) } finally { online(true) }
}

describe('a Retry-After hold on the batch flush', () => {
  it('sends nothing before the pause ends, then sends', async () => {
    let fail = true
    const { engine, calls } = make((_m, path, body) => {
      if (path.includes('/sync/batch')) {
        if (fail) throw BUSY(60_000)
        return ok(body)
      }
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    expect(calls('/sync/batch')).toBe(1)
    expect(engine.serverHoldUntil()).toBe(Date.now() + 60_000)
    expect(engine.nextFlushTime()).toBeGreaterThanOrEqual(Date.now() + 60_000)
    fail = false
    await advance(59_000)
    expect(await engine.flush()).toBeNull()
    expect(calls('/sync/batch')).toBe(1)
    await advance(1_001)
    await engine.flush()
    expect(calls('/sync/batch')).toBe(2)
    expect(engine.serverHoldUntil()).toBe(0)
  })

  it('flushNow, retryFailed and retryDeadLettered do not lift the hold', async () => {
    const { engine, calls } = make((_m, path) => {
      if (path.includes('/sync/batch')) throw BUSY(60_000)
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    expect(calls('/sync/batch')).toBe(1)
    expect(await engine.flushNow()).toBeNull()
    await engine.retryFailed()
    await engine.retryDeadLettered('nope')
    expect(await engine.flushNow()).toBeNull()
    expect(calls('/sync/batch')).toBe(1)
    expect(engine.serverHoldUntil()).toBeGreaterThan(Date.now())
  })

  it('the window online event does not lift the hold', async () => {
    const handlers: Record<string, () => void> = {}
    vi.stubGlobal('window', {
      addEventListener: (n: string, h: () => void) => { handlers[n] = h },
      removeEventListener: () => undefined,
    })
    const { engine, calls } = make((_m, path) => {
      if (path.includes('/sync/batch')) throw BUSY(60_000)
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    const batches = calls('/sync/batch')
    const versions = calls('/sync/version')
    const stop = engine.start(10 * 60_000)
    handlers.online()
    await advance(1_000)
    expect(calls('/sync/batch')).toBe(batches)
    expect(calls('/sync/version')).toBe(versions)
    stop()
  })

  it('a failure without Retry-After sets no hold', async () => {
    const { engine } = make((_m, path) => {
      if (path.includes('/sync/batch')) throw BUSY(undefined)
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    expect(engine.serverHoldUntil()).toBe(0)
  })

  it('a 500 never holds, even with a retryAfterMs-less error', async () => {
    const { engine } = make((_m, path) => {
      if (path.includes('/sync/batch')) throw Object.assign(new Error('boom'), { status: 500, kind: 'http' })
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    expect(engine.serverHoldUntil()).toBe(0)
  })

  it('a 503 burns no attempt and parks nothing', async () => {
    const { engine } = make((_m, path) => {
      if (path.includes('/sync/batch')) throw BUSY(60_000)
      return { data: { version: 0 } }
    })
    await queueOrder(engine)
    await engine.flush()
    expect(engine.reviewItems()).toHaveLength(0)
    expect(engine.outbox.all()[0]).toMatchObject({ status: expect.stringMatching(/pending|failed/) })
    expect(engine.outbox.all()[0].attempts ?? 0).toBe(0)
  })
})

describe('a Retry-After hold on the version poll', () => {
  it('checkVersion inside the hold makes no request and leaves reachability and contact alone', async () => {
    let batchFails = true
    const { engine, calls } = make((_m, path, body) => {
      if (path.includes('/sync/batch')) {
        if (batchFails) throw BUSY(60_000)
        return ok(body)
      }
      if (path.includes('/sync/version')) return { data: { version: 0 } }
      return { data: {} }
    })
    await engine.checkVersion() // a 2xx contact before the hold
    expect(engine.isReachable()).toBe(true)
    const contactBefore = JSON.stringify(contactOf(engine))
    await queueOrder(engine)
    await engine.flush()
    batchFails = false
    const versions = calls('/sync/version')
    await advance(30_000)
    await engine.checkVersion()
    expect(calls('/sync/version')).toBe(versions)
    expect(engine.isReachable()).toBe(true)
    expect(engine.connectionState()).toBe('online')
    expect(JSON.stringify(contactOf(engine))).toBe(contactBefore)
    await advance(31_000)
    await engine.checkVersion()
    expect(calls('/sync/version')).toBe(versions + 1)
  })

  it('a 429 on the version poll itself holds the next poll', async () => {
    const { engine, calls } = make((_m, path) => {
      if (path.includes('/sync/version')) throw Object.assign(new Error('slow down'), { status: 429, kind: 'http', retryAfterMs: 30_000 })
      return { data: {} }
    })
    await engine.checkVersion()
    await engine.checkVersion()
    expect(calls('/sync/version')).toBe(1)
    await advance(30_001)
    await engine.checkVersion()
    expect(calls('/sync/version')).toBe(2)
  })
})

describe('a Retry-After hold on the background pull', () => {
  it('waits at least the requested pause before pulling again', async () => {
    let version = 1
    let pullFails = false
    const { engine, calls } = make((method, path) => {
      if (method === 'GET' && path.includes('/sync/pull')) {
        if (pullFails) throw BUSY(300_000)
        return { data: { version, products: [], categories: [], bundles: [], customers: [], promotions: [], discountCodes: [], loyaltyConditions: [] } }
      }
      if (path.includes('/sync/version')) return { data: { version } }
      if (path.includes('/sync/inbound')) return { data: [] }
      return { data: { resolved: [] } }
    })
    await engine.resync()
    engine.setAutoPullGate(() => true)
    const stop = engine.start(POLL)
    const base = calls('/sync/pull')
    version = 2
    pullFails = true
    await advance(POLL) // the poll raises the wall
    await advance(5_000) // jitter: the pull runs and gets a 503 + Retry-After 300 s
    expect(calls('/sync/pull')).toBe(base + 1)
    pullFails = false
    await advance(299_000)
    expect(calls('/sync/pull')).toBe(base + 1)
    await advance(60_000)
    expect(calls('/sync/pull')).toBe(base + 2)
    stop()
  })
})

describe('shift items held behind a retryable item', () => {
  const pendingShift = (e: SyncEngine) => e.outbox.all().find((i) => i.type === 'shift_close')

  it('the whole-batch path exposes a reason, cleared by the next flush', async () => {
    const sent: string[][] = []
    let firstRetryable = true
    const { engine } = make((_m, path, body) => {
      if (!path.includes('/sync/batch') || !body) return { data: { version: 0 } }
      sent.push(body.items.map((i) => i.type))
      return {
        data: {
          processed: 0, version: 0,
          results: body.items.map((i, n) => (firstRetryable && n === 0 && i.type === 'order'
            ? { idempotencyKey: i.idempotencyKey, status: 'error', error: 'sibuk', code: 'busy', retryable: true }
            : { idempotencyKey: i.idempotencyKey, status: 'ok' })),
        },
      }
    })
    online(false)
    for (let n = 0; n < 25; n++) await engine.enqueue('order', { total: n })
    await engine.enqueue('shift_close', { closingCash: 0 })
    online(true)
    await engine.flushNow()
    expect(sent.map((s) => s.length)).toEqual([25]) // chunk 2 held its close
    const held = engine.heldItems()
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ type: 'shift_close', heldReason: 'Ditunda: menunggu transaksi sebelumnya terkirim' })
    expect(pendingShift(engine)?.status).toBe('pending')
    firstRetryable = false
    await engine.flushNow()
    expect(engine.heldItems()).toEqual([])
    expect(sent.at(-1)).toContain('shift_close')
  })

  it('the isolation path holds a shift behind an item whose retryable flag is missing', async () => {
    const sent: string[][] = []
    const { engine } = make((_m, path, body) => {
      if (!path.includes('/sync/batch') || !body) return { data: { version: 0 } }
      sent.push(body.items.map((i) => i.type))
      if (body.items.length > 1) throw Object.assign(new Error('bad request'), { status: 400, kind: 'http' })
      const [it] = body.items
      if (it.type === 'order') {
        return { data: { processed: 0, version: 0, results: [{ idempotencyKey: it.idempotencyKey, status: 'error', error: 'sibuk' }] } }
      }
      return { data: { processed: 1, version: 0, results: [{ idempotencyKey: it.idempotencyKey, status: 'ok' }] } }
    })
    online(false)
    await engine.enqueue('order', { total: 1 })
    await engine.enqueue('shift_close', { closingCash: 0 })
    online(true)
    await engine.flushNow()
    expect(sent).toEqual([['order', 'shift_close'], ['order']]) // the close never went out alone
    expect(pendingShift(engine)?.status).toBe('pending')
    expect(engine.heldItems().map((h) => h.type)).toEqual(['shift_close'])
  })
})
