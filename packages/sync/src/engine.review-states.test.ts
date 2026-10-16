import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, SyncEngine, type ApiLike } from './engine'
import { MAX_ATTEMPTS, Outbox, type OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// The predicate shipped in APK 1.1 (`git show 4c42dbe:packages/sync/src/outbox.ts`,
// Outbox.pending()). A review item must be excluded by it so a tablet that rolls back
// to that bundle neither resends nor deletes it.
const oldPending = (items: OutboxItem[]) =>
  items.filter((i) => i.status !== 'acked' && !(i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS))

type Err = Error & { status?: number; kind?: string }
const apiError = (status: number, message: string, kind: string = 'http'): Err =>
  Object.assign(new Error(message), { status, kind })
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const ok = (keys: string[]) => ({
  data: { processed: keys.length, version: 0, results: keys.map((idempotencyKey) => ({ idempotencyKey, status: 'ok' })) },
})

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
  vi.spyOn(Math, 'random').mockReturnValue(1) // jitter factor 1 => delay is exactly base * 2^n
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(request: unknown, keys = ['dev:1']) {
  const { kv, store } = controllableKV()
  const engine = new SyncEngine(api(request), {}, kv, { actor: null })
  for (const k of keys) await engine.outbox.add('order', k, { total: 1 })
  return { engine, store, kv }
}

describe('whole-batch failures are typed and never blame the item unless deterministic', () => {
  it('a network TypeError counts nothing and sets no backoff', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { engine } = await setup(request)
    expect(await engine.flush()).toBeNull()
    const item = engine.outbox.all()[0]
    expect(item.attempts ?? 0).toBe(0)
    expect(item.retryableFailures ?? 0).toBe(0)
    expect(item.status).toBe('pending')
    expect(engine.nextFlushTime()).toBe(0)
    expect(engine.isReachable()).toBe(false)
    expect(await engine.flush()).toBeNull()
    expect(request).toHaveBeenCalledTimes(2) // no backoff: the next poll tries again
  })

  it('a typed network error from the api client counts nothing either', async () => {
    const { engine } = await setup(vi.fn().mockRejectedValue(apiError(0, 'network error', 'network')))
    await engine.flush()
    expect(engine.outbox.all()[0]).toMatchObject({ status: 'pending' })
    expect(engine.outbox.all()[0].retryableFailures).toBeUndefined()
  })

  it('a request timeout (abort) adds a retryable failure, no attempt, and backs off', async () => {
    const { engine } = await setup(vi.fn().mockRejectedValue(apiError(0, 'timeout', 'timeout')))
    await engine.flush()
    const item = engine.outbox.all()[0]
    expect(item.retryableFailures).toBe(1)
    expect(item.attempts ?? 0).toBe(0)
    expect(engine.nextFlushTime()).toBeGreaterThan(Date.now())
  })

  it('passes a 30 s timeout to the batch request', async () => {
    const request = vi.fn().mockResolvedValue(ok(['dev:1']))
    const { engine } = await setup(request)
    await engine.flush()
    expect(request.mock.calls[0][3]).toEqual({ timeoutMs: 30_000 })
  })

  it.each([
    ['HTML 502 page (invalid_response)', apiError(502, 'respons server tidak valid (502)', 'invalid_response')],
    ['JSON 503', apiError(503, 'unavailable')],
    ['429', apiError(429, 'slow down')],
  ])('%s: retryable failure, no attempt, backoff set', async (_n, err) => {
    const { engine } = await setup(vi.fn().mockRejectedValue(err))
    await engine.flush()
    const item = engine.outbox.all()[0]
    expect(item).toMatchObject({ status: 'failed', retryableFailures: 1 })
    expect(item.attempts ?? 0).toBe(0)
    expect(engine.pendingCount()).toBe(1)
    expect(engine.nextFlushTime()).toBe(Date.now() + BACKOFF_BASE_MS)
  })

  it('a long outage still trips the after-10 report without ever parking', async () => {
    const onStuckRetrying = vi.fn()
    const { kv } = controllableKV()
    const request = vi.fn().mockRejectedValue(apiError(503, 'down'))
    const engine = new SyncEngine(api(request), { onStuckRetrying }, kv, { actor: null })
    await engine.outbox.add('order', 'dev:1', {})
    for (let i = 0; i < 10; i++) {
      await engine.flushNow()
    }
    expect(onStuckRetrying).toHaveBeenCalledTimes(1)
    expect(engine.outbox.all()[0].attempts ?? 0).toBe(0)
    expect(engine.reviewItems()).toEqual([])
  })

  it('a 401 (after the client already tried the refresh path) counts nothing and keeps the item queued', async () => {
    const { engine } = await setup(vi.fn().mockRejectedValue(apiError(401, 'unauthorized')))
    await engine.flush()
    const item = engine.outbox.all()[0]
    expect(item).toMatchObject({ status: 'pending' })
    expect(item.attempts ?? 0).toBe(0)
    expect(item.retryableFailures).toBeUndefined()
    expect(engine.pendingCount()).toBe(1)
  })
})

describe('transient backoff', () => {
  it('skips flushes until nextFlushAt, doubles with each failure, and is capped', async () => {
    const request = vi.fn().mockRejectedValue(apiError(503, 'down'))
    const { engine } = await setup(request)
    await engine.flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(await engine.flush()).toBeNull() // inside the window
    expect(request).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + BACKOFF_BASE_MS - 1)
    await engine.flush()
    expect(request).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 1)
    await engine.flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(engine.nextFlushTime()).toBe(Date.now() + BACKOFF_BASE_MS * 2)

    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(engine.nextFlushTime())
      await engine.flush()
    }
    expect(engine.nextFlushTime() - Date.now()).toBe(BACKOFF_CAP_MS)
  })

  it('applies jitter within [50%, 100%] of the step', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { engine } = await setup(vi.fn().mockRejectedValue(apiError(503, 'down')))
    await engine.flush()
    expect(engine.nextFlushTime()).toBe(Date.now() + BACKOFF_BASE_MS / 2)
  })

  it('resets on success', async () => {
    const request = vi.fn().mockRejectedValueOnce(apiError(503, 'down')).mockResolvedValue(ok(['dev:1']))
    const { engine } = await setup(request)
    await engine.flush()
    expect(engine.nextFlushTime()).toBeGreaterThan(0)
    vi.setSystemTime(engine.nextFlushTime())
    await engine.flush()
    expect(engine.nextFlushTime()).toBe(0)
  })

  it('resets when the window fires `online`', async () => {
    const handlers = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (ev: string, fn: () => void) => handlers.set(ev, fn),
      removeEventListener: (ev: string) => handlers.delete(ev),
    })
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET') return { data: [] }
      void path
      throw apiError(503, 'down')
    })
    const { engine } = await setup(request)
    const stop = engine.start(10 * 60_000)
    await engine.flush()
    expect(engine.nextFlushTime()).toBeGreaterThan(Date.now())
    const before = request.mock.calls.filter((c) => c[0] === 'POST').length
    handlers.get('online')!()
    await vi.waitFor(() => expect(request.mock.calls.filter((c) => c[0] === 'POST').length).toBe(before + 1))
    stop()
    engine.dispose()
  })

  it('manual retry and "send now" reset it', async () => {
    const request = vi.fn().mockRejectedValue(apiError(503, 'down'))
    const { engine } = await setup(request)
    await engine.flush()
    expect(engine.nextFlushTime()).toBeGreaterThan(0)
    const t0 = Date.now()
    await engine.retryFailed()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)) // retryFailed re-flushes at once
    await vi.waitFor(() => expect(engine.nextFlushTime()).toBeGreaterThan(0))
    expect(engine.nextFlushTime() - t0).toBeLessThan(BACKOFF_BASE_MS + 1_000) // step restarted at 1, not 2
    expect(await engine.flush()).toBeNull() // backed off again
    await engine.flushNow()
    expect(request).toHaveBeenCalledTimes(3)
  })
})

describe('deterministic 4xx: isolate the bad item', () => {
  const setup3 = async () => {
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => {
      const keys = body.items.map((i) => i.idempotencyKey)
      if (keys.length > 1 || keys[0] === 'dev:bad') throw apiError(400, 'invalid body')
      return ok(keys)
    })
    const s = await setup(request, ['dev:1', 'dev:bad', 'dev:3'])
    return { ...s, request }
  }

  it('acks the good items and puts only the bad one in review with batch_rejected', async () => {
    const { engine, request } = await setup3()
    await engine.flush()
    expect(engine.outbox.all().map((i) => i.idempotencyKey)).toEqual(['dev:bad'])
    expect(engine.outbox.all()[0]).toMatchObject({
      status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'batch_rejected', reviewReason: 'invalid body', lastError: 'invalid body',
    })
    expect(engine.reviewItems()).toHaveLength(1)
    expect(engine.pendingCount()).toBe(0)
    // 1 whole batch + 3 single-item requests, in order
    expect(request).toHaveBeenCalledTimes(4)
    expect(request.mock.calls.slice(1).map((c) => (c[2] as { items: { idempotencyKey: string }[] }).items[0].idempotencyKey))
      .toEqual(['dev:1', 'dev:bad', 'dev:3'])
  })

  it.each([400, 413, 422])('a whole-batch %i is isolated per item', async (status) => {
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => {
      if (body.items.length > 1) throw apiError(status, 'bad body')
      return ok(body.items.map((i) => i.idempotencyKey))
    })
    const { engine } = await setup(request, ['dev:1', 'dev:2'])
    await engine.flush()
    expect(engine.outbox.all()).toEqual([])
  })

  it.each([
    ['JSON 403 (no active outlet)', apiError(403, 'no active outlet')],
    ['JSON 403 (outlet not permitted)', apiError(403, 'outlet not permitted')],
    ['non-JSON 403 (proxy / captive portal)', apiError(403, 'request failed (403)')],
    ['404 (wrong base URL)', apiError(404, 'request failed (404)')],
    ['405', apiError(405, 'request failed (405)')],
    ['407', apiError(407, 'request failed (407)')],
  ])('%s: nothing parked or counted, backoff set, account problem flagged', async (_n, err) => {
    const request = vi.fn().mockRejectedValue(err)
    const { engine } = await setup(request, ['dev:1', 'dev:2'])
    expect(engine.accountProblem()).toBeNull()
    await engine.flush()
    expect(request).toHaveBeenCalledTimes(1) // no per-item resend
    for (const i of engine.outbox.all()) {
      expect(i).toMatchObject({ status: 'pending' })
      expect(i.attempts ?? 0).toBe(0)
      expect(i.retryableFailures).toBeUndefined()
      expect(i.reviewCode).toBeUndefined()
    }
    expect(engine.reviewItems()).toEqual([])
    expect(engine.pendingCount()).toBe(2)
    expect(engine.nextFlushTime()).toBe(Date.now() + BACKOFF_BASE_MS)
    expect(engine.accountProblem()).toContain('Masalah akun/outlet')
  })

  it('the account problem clears after a good batch', async () => {
    const request = vi.fn().mockRejectedValueOnce(apiError(403, 'no active outlet')).mockResolvedValue(ok(['dev:1']))
    const { engine } = await setup(request)
    await engine.flush()
    expect(engine.accountProblem()).not.toBeNull()
    await engine.flushNow()
    expect(engine.accountProblem()).toBeNull()
  })

  it('a 403 met while isolating a 400 stops there and parks nothing', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => {
      if (body.items.length > 1) throw apiError(400, 'bad body')
      throw apiError(403, 'no active outlet')
    })
    const { engine } = await setup(request, ['dev:1', 'dev:2'])
    await engine.flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(engine.reviewItems()).toEqual([])
    expect(engine.outbox.all()).toHaveLength(2)
    expect(engine.accountProblem()).not.toBeNull()
  })

  it('stops isolating on a transient failure and holds nothing against the rest', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => {
      const keys = body.items.map((i) => i.idempotencyKey)
      if (keys.length > 1) throw apiError(400, 'invalid body')
      if (keys[0] === 'dev:1') return ok(keys)
      throw apiError(503, 'down')
    })
    const { engine } = await setup(request, ['dev:1', 'dev:2', 'dev:3'])
    await engine.flush()
    const left = engine.outbox.all()
    expect(left.map((i) => i.idempotencyKey)).toEqual(['dev:2', 'dev:3'])
    for (const i of left) {
      expect(i.attempts ?? 0).toBe(0)
      expect(i.retryableFailures).toBe(1)
    }
    expect(engine.reviewItems()).toEqual([])
    expect(engine.nextFlushTime()).toBeGreaterThan(Date.now())
  })
})

describe('review state is rollback-safe', () => {
  it('review items are excluded by the APK 1.1 pending() predicate and survive a restart', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'denied', code: 'forbidden', retryable: false })),
      },
    }))
    const { engine, kv } = await setup(request)
    await engine.flush()
    const stored = new Outbox(kv).all() as OutboxItem[]
    expect(stored).toHaveLength(1)
    expect(stored[0].status).toBe('failed') // no new status value is ever written
    expect(oldPending(stored)).toEqual([])
    expect(oldPending(stored as OutboxItem[]).length).toBe(0)
    expect(new Outbox(kv).pending()).toEqual([])
    expect(new Outbox(kv).reviewItems()[0]).toMatchObject({ reviewCode: 'forbidden', reviewReason: 'denied' })
  })

  it('a denied refund is review, visible and kept', async () => {
    const { kv } = controllableKV()
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'no permission', code: 'forbidden', retryable: false })),
      },
    }))
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    await engine.outbox.add('refund', 'dev:r1', { orderId: 'o1' })
    await engine.flush()
    expect(engine.reviewItems()).toMatchObject([{ type: 'refund', reviewCode: 'forbidden' }])
    expect(oldPending(engine.outbox.all() as OutboxItem[])).toEqual([])
    expect(engine.outbox.all()[0].payload).toEqual({ orderId: 'o1' })
  })

  it.each(['rejected', 'conflict'])('a refund refused with `%s` (A06 rules) is review: payload kept, never deleted, retried under the same key', async (code) => {
    const { kv } = controllableKV()
    const sentKeys: string[] = []
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => {
      sentKeys.push(...body.items.map((i) => i.idempotencyKey))
      return {
        data: {
          processed: 0, version: 0,
          results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'sudah direfund', code, retryable: false })),
        },
      }
    })
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    const payload = { orderId: 'o1', reason: 'rusak', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', saleShiftId: 's0' }
    await engine.outbox.add('refund', 'dev:r1', payload)
    await engine.flush()
    expect(engine.reviewItems()).toMatchObject([{ type: 'refund', reviewCode: code, payload }])
    expect(engine.outbox.all()[0].payload).toEqual(payload)
    expect(oldPending(engine.outbox.all() as OutboxItem[])).toEqual([])
    expect(await engine.flush()).toBeNull() // never auto-retried
    await engine.retryFailed()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(sentKeys).toEqual(['dev:r1', 'dev:r1'])
    expect(engine.outbox.all()[0].payload).toEqual(payload)
  })

  it('manual retry clears the review fields, resets attempts and the backoff, and resends', async () => {
    const results: ('review' | 'ok')[] = ['review']
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) =>
          results[0] === 'ok'
            ? { idempotencyKey: i.idempotencyKey, status: 'ok' }
            : { idempotencyKey: i.idempotencyKey, status: 'error', error: 'denied', code: 'forbidden', retryable: false }),
      },
    }))
    const { engine } = await setup(request)
    await engine.flush()
    expect(engine.reviewItems()).toHaveLength(1)
    expect(await engine.flush()).toBeNull() // never auto-retried
    expect(request).toHaveBeenCalledTimes(1)

    results[0] = 'ok'
    await engine.retryFailed()
    await vi.waitFor(() => expect(engine.outbox.all()).toEqual([]))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retryDeadLettered clears review fields and the retryable counter', async () => {
    const { engine } = await setup(vi.fn().mockResolvedValue({
      data: { processed: 0, version: 0, results: [{ idempotencyKey: 'dev:1', status: 'error', error: 'x', code: 'rejected', retryable: false }] },
    }))
    await engine.flush()
    await engine.outbox.retryDeadLettered()
    const item = engine.outbox.all()[0]
    expect(item).toMatchObject({ status: 'pending', attempts: 0 })
    expect(item.reviewCode).toBeUndefined()
    expect(item.reviewReason).toBeUndefined()
  })

  it('an item parked by the old attempt counting (no reviewCode) is still listed for review', async () => {
    const { kv } = controllableKV({
      'mandalika.pos.outbox': JSON.stringify([
        { idempotencyKey: 'dev:old', type: 'order', payload: {}, seq: 1, status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'boom', clientCreatedAt: 't' },
      ]),
    })
    const engine = new SyncEngine(api(vi.fn()), {}, kv, { actor: null })
    expect(engine.reviewItems()).toEqual([
      { idempotencyKey: 'dev:old', type: 'order', clientCreatedAt: 't', reviewCode: undefined, reviewReason: 'boom', lastError: 'boom', payload: {} },
    ])
  })
})

describe('transfer_receive competing receipt', () => {
  it('goes to review keeping the counted payload, removes only the optimistic credit', async () => {
    const { kv, store } = controllableKV()
    const onReceiveRejected = vi.fn()
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({
          idempotencyKey: i.idempotencyKey, status: 'error', error: 'already received', code: 'competing_receipt', retryable: false,
        })),
      },
    }))
    vi.stubGlobal('navigator', { onLine: false }) // enqueue must not auto-flush
    const engine = new SyncEngine(api(request), { onReceiveRejected }, kv, { actor: null })
    await engine.enqueueTransferReceive({
      transferId: 't1', approverUserId: 'u1', pin: '1234', discrepancyReason: 'rusak 1',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 4 }],
    })
    expect(engine.pending.list()).toHaveLength(1)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flush()

    expect(engine.pending.list()).toEqual([])
    const item = engine.outbox.all()[0]
    expect(item).toMatchObject({
      type: 'transfer_receive', status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'competing_receipt',
      payload: { transferId: 't1', discrepancyReason: 'rusak 1', items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 4 }] },
    })
    // the approver PIN does not outlive its use: gone from memory and from storage
    expect(item.payload).not.toHaveProperty('pin')
    expect(store.get('mandalika.pos.outbox')).not.toContain('"1234"')
    expect(store.get('mandalika.pos.outbox')).not.toContain('"pin"')
    expect(oldPending(engine.outbox.all() as OutboxItem[])).toEqual([])
    expect(onReceiveRejected).toHaveBeenCalledWith(expect.stringContaining('perlu ditinjau'))
    expect(onReceiveRejected.mock.calls[0][0]).not.toMatch(/dibatalkan/)
  })

  it('retrying a PIN-stripped receive does not crash: the server verdict sends it back to review', async () => {
    const { kv } = controllableKV()
    let phase: 'conflict' | 'forbidden' = 'conflict'
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string; payload: Record<string, unknown> }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({
          idempotencyKey: i.idempotencyKey, status: 'error', retryable: false,
          ...(phase === 'conflict'
            ? { error: 'already received', code: 'competing_receipt' }
            : { error: i.payload.pin === undefined ? 'PIN salah' : 'unexpected', code: 'forbidden' }),
        })),
      },
    }))
    vi.stubGlobal('navigator', { onLine: false })
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    await engine.enqueueTransferReceive({
      transferId: 't1', approverUserId: 'u1', pin: '1234',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 4 }],
    })
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flush()
    expect(engine.reviewItems()[0].reviewCode).toBe('competing_receipt')

    phase = 'forbidden'
    await engine.retryFailed()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(engine.reviewItems()[0]?.reviewCode).toBe('forbidden'))
    expect(engine.reviewItems()[0].reviewReason).toBe('PIN salah')
    expect(engine.outbox.all()[0].payload).not.toHaveProperty('pin')
    expect(engine.outbox.all()[0].payload).toMatchObject({ items: [{ receivedQty: 4 }] })
  })
})
