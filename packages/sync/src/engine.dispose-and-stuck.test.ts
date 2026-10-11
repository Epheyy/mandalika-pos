import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { MAX_ATTEMPTS, Outbox, RETRYABLE_ATTENTION_AFTER, type OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

const OUTBOX_KEY = 'mandalika.pos.outbox'
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const stored = (store: Map<string, string>): OutboxItem[] => JSON.parse(store.get(OUTBOX_KEY) ?? '[]')

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('dispose: only the live instance writes the outbox', () => {
  it('a disposed engine mid-flush cannot overwrite what the new outbox committed', async () => {
    const { kv, store } = controllableKV()
    let failOldRequest!: (e: Error) => void
    const oldRequest = vi.fn(() => new Promise((_res, rej) => { failOldRequest = rej }))
    const oldEngine = new SyncEngine(api(oldRequest), {}, kv, { actor: null })
    await oldEngine.outbox.add('order', 'dev:old', {})
    const flushing = oldEngine.flush() // old request now in flight
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalled())

    oldEngine.dispose() // logout: SyncProvider unmounted
    const next = new Outbox(kv) // re-login builds a fresh outbox over the same storage
    await next.add('order', 'dev:next-cashier-sale', {})

    vi.spyOn(console, 'error').mockImplementation(() => {})
    failOldRequest(new Error('network died')) // the old flush now settles its failure
    await flushing
    await oldEngine.outbox.idle()

    const keys = stored(store).map((i) => i.idempotencyKey)
    expect(keys).toContain('dev:next-cashier-sale')
    expect(new Outbox(kv).all().map((i) => i.idempotencyKey)).toEqual(keys)
  })

  it('a disposed outbox rejects add and ignores settle; revive restores it', async () => {
    const { kv, store } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:1', {})
    outbox.dispose()
    await expect(outbox.add('order', 'dev:2', {})).rejects.toThrow('disposed')
    await outbox.ack('dev:1')
    expect(stored(store).map((i) => [i.idempotencyKey, i.status])).toEqual([['dev:1', 'pending']])
    outbox.revive()
    await outbox.ack('dev:1')
    expect(stored(store)[0].status).toBe('acked')
  })

  it('a disposed engine ignores the late result of an in-flight flush', async () => {
    const { kv, store } = controllableKV()
    let finish!: (v: unknown) => void
    const request = vi.fn(() => new Promise((res) => { finish = res }))
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    await engine.outbox.add('order', 'dev:1', {})
    const flushing = engine.flush()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    engine.dispose()
    finish({ data: { processed: 1, version: 0, results: [{ idempotencyKey: 'dev:1', status: 'ok' }] } })
    expect(await flushing).toBeNull()
    expect(stored(store)[0].status).toBe('pending')
    expect(await engine.flush()).toBeNull() // and it will not start new flushes
  })
})

describe('retryable failures: keep retrying but surface after N in a row', () => {
  const setup = () => {
    const { kv } = controllableKV()
    const mode = { result: 'retryable' as 'retryable' | 'ok' | 'rejected' }
    const onStuckRetrying = vi.fn()
    const onDeadLetter = vi.fn()
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => mode.result === 'ok'
          ? { idempotencyKey: i.idempotencyKey, status: 'ok' }
          : mode.result === 'rejected'
            ? { idempotencyKey: i.idempotencyKey, status: 'error', error: 'bad', code: 'rejected', retryable: false }
            : { idempotencyKey: i.idempotencyKey, status: 'error', error: 'fk violation', code: 'internal', retryable: true }),
      },
    }))
    const engine = new SyncEngine(api(request), { onStuckRetrying, onDeadLetter }, kv, { actor: null })
    return { engine, mode, request, onStuckRetrying, onDeadLetter }
  }

  it('reports once after N retryable failures, flags it, and keeps sending', async () => {
    const { engine, request, onStuckRetrying, onDeadLetter } = setup()
    await engine.outbox.add('order', 'dev:1', { total: 1 })
    for (let i = 0; i < RETRYABLE_ATTENTION_AFTER - 1; i++) await engine.flush()
    expect(onStuckRetrying).not.toHaveBeenCalled()
    expect(engine.stuckRetrying()).toEqual([])

    await engine.flush()
    expect(onStuckRetrying).toHaveBeenCalledTimes(1)
    expect(onStuckRetrying.mock.calls[0][0][0]).toMatchObject({ idempotencyKey: 'dev:1', lastError: 'fk violation' })
    expect(engine.stuckRetrying().map((s) => s.idempotencyKey)).toEqual(['dev:1'])
    expect(engine.outbox.all()[0].attempts ?? 0).toBe(0)
    expect(engine.deadLettered()).toEqual([])
    expect(onDeadLetter).not.toHaveBeenCalled()

    const sent = request.mock.calls.length
    await engine.flush() // still pending and sent on the next poll
    expect(request.mock.calls.length).toBe(sent + 1)
    expect(onStuckRetrying).toHaveBeenCalledTimes(1) // reported once only
    expect(engine.pendingCount()).toBe(1)
  })

  it('a success clears it', async () => {
    const { engine, mode } = setup()
    await engine.outbox.add('order', 'dev:1', {})
    for (let i = 0; i < RETRYABLE_ATTENTION_AFTER; i++) await engine.flush()
    expect(engine.stuckRetrying()).toHaveLength(1)
    mode.result = 'ok'
    await engine.flush()
    expect(engine.stuckRetrying()).toEqual([])
    expect(engine.outbox.all()).toEqual([])
  })

  it('a non-retryable result resets the consecutive count', async () => {
    const { engine, mode } = setup()
    await engine.outbox.add('order', 'dev:1', {})
    for (let i = 0; i < RETRYABLE_ATTENTION_AFTER - 1; i++) await engine.flush()
    expect(engine.outbox.all()[0].retryableFailures).toBe(RETRYABLE_ATTENTION_AFTER - 1)
    mode.result = 'rejected'
    await engine.flush()
    expect(engine.outbox.all()[0].retryableFailures).toBeUndefined()
    // a known non-retryable code goes straight to review (parked at the attempt cap)
    expect(engine.outbox.all()[0]).toMatchObject({ attempts: MAX_ATTEMPTS, reviewCode: 'rejected' })
  })

  it('the counter survives a restart (stored additively with the item)', async () => {
    const { kv } = controllableKV()
    const request = vi.fn(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
      data: { processed: 0, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'e', code: 'busy', retryable: true })) },
    }))
    const first = new SyncEngine(api(request), {}, kv, { actor: null })
    await first.outbox.add('order', 'dev:1', {})
    for (let i = 0; i < 3; i++) await first.flush()
    expect(new Outbox(kv).all()[0].retryableFailures).toBe(3)
  })
})
