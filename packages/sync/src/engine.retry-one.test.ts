import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })

beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function parkedEngine(keys: string[], actor: (() => { outletId: string; userId: string }) | null = null) {
  const request = vi.fn().mockRejectedValue(new TypeError('offline'))
  const engine = new SyncEngine(api(request), {}, controllableKV().kv, { actor: actor ?? null })
  for (const k of keys) await engine.outbox.add('order', k, { total: 1 })
  await engine.outbox.settle(keys.map((key) => ({ key, op: 'review' as const, code: 'rejected', reason: 'x' })))
  return engine
}

describe('SyncEngine.retryDeadLettered (C2 per-item retry)', () => {
  it('re-queues only the named parked item; the others stay parked', async () => {
    const engine = await parkedEngine(['d:1', 'd:2'])
    await engine.retryDeadLettered('d:1')
    expect(engine.deadLettered().map((i) => i.idempotencyKey)).toEqual(['d:2'])
    expect(engine.outbox.pending().map((i) => i.idempotencyKey)).toEqual(['d:1'])
  })

  it('resets attempts and review fields exactly like retryFailed', async () => {
    const one = await parkedEngine(['d:1'])
    const all = await parkedEngine(['d:1'])
    await one.retryDeadLettered('d:1')
    await all.retryFailed()
    const strip = (e: SyncEngine) => e.outbox.pending().map(({ idempotencyKey, status, attempts, reviewCode, reviewReason }) => ({ idempotencyKey, status, attempts, reviewCode, reviewReason }))
    expect(strip(one)).toEqual(strip(all))
    expect(strip(one)[0]).toMatchObject({ status: 'pending', attempts: 0, reviewCode: undefined })
  })

  it('an unknown key is a no-op', async () => {
    const engine = await parkedEngine(['d:1'])
    await engine.retryDeadLettered('nope')
    expect(engine.deadLettered().map((i) => i.idempotencyKey)).toEqual(['d:1'])
    expect(engine.outbox.pending()).toHaveLength(0)
  })

  it('is idempotent: a second call on an already re-queued item changes nothing', async () => {
    const engine = await parkedEngine(['d:1', 'd:2'])
    await engine.retryDeadLettered('d:1')
    await engine.retryDeadLettered('d:1')
    expect(engine.outbox.pending().map((i) => i.idempotencyKey)).toEqual(['d:1'])
    expect(engine.deadLettered().map((i) => i.idempotencyKey)).toEqual(['d:2'])
  })

  it('keeps another account\'s parked item parked', async () => {
    const engine = new SyncEngine(api(vi.fn()), {}, controllableKV().kv, { actor: () => ({ outletId: 'o', userId: 'me' }) })
    await engine.outbox.add('order', 'd:theirs', { total: 1 }, { v: 1, outletId: 'o', userId: 'other', deviceId: 'd', capturedAt: 'x' } as never)
    await engine.outbox.settle([{ key: 'd:theirs', op: 'review', code: 'actor_mismatch', reason: 'x' }])
    await engine.retryDeadLettered('d:theirs')
    expect(engine.deadLettered().map((i) => i.idempotencyKey)).toEqual(['d:theirs'])
  })
})
