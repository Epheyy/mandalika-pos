import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_MAX_ITEMS, SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// A29: a large outbox goes out in slices of BATCH_MAX_ITEMS, from ONE pending() snapshot, and the
// drain stops at the first chunk that did not fully settle (the server only holds shift_close /
// shift_open behind an earlier retryable failure inside the SAME request).

interface Item { type: string; idempotencyKey: string; payload: { kind?: string; items?: unknown[] } }
type Body = { items: Item[] }
type Handler = (body: Body, call: number) => unknown
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })

const okResults = (body: Body) => ({
  data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })) },
})
const busyResults = (body: Body) => ({
  data: {
    processed: 0, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'sibuk', code: 'busy', retryable: true })),
  },
})

function setup(handler: Handler) {
  const sent: string[][] = []
  const request = vi.fn(async (_m: string, _p: string, body: Body) => {
    sent.push(body.items.map((i) => i.idempotencyKey))
    return handler(body, sent.length)
  })
  const { kv } = controllableKV()
  const engine = new SyncEngine(api(request), {}, kv, { actor: null })
  return { engine, sent, request }
}

async function fill(engine: SyncEngine, n: number, mk: (i: number) => [string, Record<string, unknown>] = () => ['order', {}]) {
  for (let i = 0; i < n; i++) {
    const [type, payload] = mk(i)
    await engine.outbox.add(type as 'order', `k${String(i).padStart(3, '0')}`, payload)
  }
}
const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `k${String(from + i).padStart(3, '0')}`)

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('flush drains the outbox in chunks', () => {
  it('(a) 120 pending go out as 5 posts of at most 25, in order, all acked', async () => {
    const { engine, sent } = setup((b) => okResults(b))
    await fill(engine, 120)
    const res = await engine.flushNow()
    expect(BATCH_MAX_ITEMS).toBe(25)
    expect(sent.map((s) => s.length)).toEqual([25, 25, 25, 25, 20])
    expect(sent.flat()).toEqual(keys(0, 120))
    expect(engine.outbox.all()).toHaveLength(0)
    expect(res?.results).toHaveLength(120) // merged result
    expect(res?.processed).toBe(120)
  })

  it('(b) a retryable error in chunk 1 stops the drain: chunk 2 (with a shift_close) is not sent', async () => {
    const { engine, sent } = setup((b) => busyResults(b))
    await fill(engine, 30, (i) => (i === 27 ? ['shift_close', { closingCash: 0 }] : ['order', {}]))
    await engine.flushNow()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual(keys(0, 25))
    expect(engine.outbox.all().find((i) => i.type === 'shift_close')).toMatchObject({ status: 'pending' })
  })

  it('(c) a 400 on chunk 2 isolates only chunk 2 and stops the drain after it', async () => {
    const { engine, sent } = setup((b, call) => {
      if (call === 2) throw Object.assign(new Error('bad request'), { status: 400, kind: 'http' })
      return okResults(b)
    })
    await fill(engine, 60) // chunks: 0-24, 25-49, 50-59
    await engine.flushNow()
    expect(sent[0]).toEqual(keys(0, 25))
    expect(sent[1]).toEqual(keys(25, 50)) // the refused chunk
    expect(sent.slice(2).every((s) => s.length === 1)).toBe(true) // then one per request, same chunk only
    expect(sent.slice(2).flat()).toEqual(keys(25, 50))
    expect(sent.flat()).not.toContain('k050') // chunk 3 not sent this flush
    expect(engine.outbox.all().map((i) => i.idempotencyKey)).toEqual(keys(50, 60))
  })

  it('(d) a timeout on chunk 2 keeps chunk 1 acked, backs off, burns no attempt', async () => {
    const { engine, sent } = setup((b, call) => {
      if (call === 2) throw Object.assign(new Error('timeout'), { kind: 'timeout' })
      return okResults(b)
    })
    await fill(engine, 60)
    await engine.flushNow()
    expect(sent).toHaveLength(2) // no chunk 3
    const left = engine.outbox.all()
    expect(left.map((i) => i.idempotencyKey)).toEqual(keys(25, 60)) // chunk 1 acked and pruned
    expect(left.every((i) => (i.attempts ?? 0) === 0)).toBe(true)
    await engine.flush() // inside the backoff window
    expect(sent).toHaveLength(2)
  })

  it('(e) dispose mid-drain stops: no further chunk is posted', async () => {
    const ref: { engine?: SyncEngine } = {}
    const { engine, sent } = setup((b, call) => {
      if (call === 1) ref.engine?.dispose()
      return okResults(b)
    })
    ref.engine = engine
    await fill(engine, 60)
    expect(await engine.flushNow()).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('going offline between chunks stops the drain without posting', async () => {
    const { engine, sent } = setup((b, call) => {
      if (call === 1) vi.stubGlobal('navigator', { onLine: false })
      return okResults(b)
    })
    await fill(engine, 60)
    await engine.flushNow()
    expect(sent).toHaveLength(1)
    expect(engine.outbox.all()).toHaveLength(35)
  })

  it('(f) an item enqueued during the drain is not sent in this flush', async () => {
    const ref: { engine?: SyncEngine } = {}
    const { engine, sent } = setup(async (b, call) => {
      if (call === 1) await ref.engine!.outbox.add('order', 'late', {})
      return okResults(b)
    })
    ref.engine = engine
    await fill(engine, 30)
    await engine.flushNow()
    expect(sent.flat()).toEqual(keys(0, 30))
    expect(engine.outbox.all().map((i) => i.idempotencyKey)).toEqual(['late'])
  })

  it('(g) A15: acked orders record their settling debits in every chunk', async () => {
    const { engine, sent } = setup((b) => okResults(b))
    const line = { items: [{ productId: 'p1', variantSize: '10ml', quantity: 1 }] }
    vi.stubGlobal('navigator', { onLine: false }) // enqueue auto-flushes when online
    for (let i = 0; i < 60; i++) await engine.enqueue('order', line)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(sent.map((s) => s.length)).toEqual([25, 25, 10])
    expect(engine.outbox.all()).toHaveLength(0)
    expect(engine.pendingStockDeltas()['p1|10ml']).toBe(60)
  })
})
