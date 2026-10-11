import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// M3 follow-up: when the whole batch is refused (4xx) the engine resends item by item. A later
// shift_close must never go out alone after an earlier item came back retryable: the server hold
// only sees items of the same request.

type Body = { items: { type: string; idempotencyKey: string }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isolation loop stops at the first retryable item', () => {
  it('leaves the later shift_close pending and unsent', async () => {
    const sent: string[][] = []
    const request = vi.fn(async (_m: string, _p: string, body: Body) => {
      sent.push(body.items.map((i) => i.type))
      if (body.items.length > 1) throw Object.assign(new Error('bad request'), { status: 400, kind: 'http' })
      const [it] = body.items
      if (it.type === 'order') {
        return { data: { processed: 0, version: 0, results: [{ idempotencyKey: it.idempotencyKey, status: 'error', error: 'sibuk', code: 'busy', retryable: true }] } }
      }
      return { data: { processed: 1, version: 0, results: [{ idempotencyKey: it.idempotencyKey, status: 'ok' }] } }
    })
    const { kv } = controllableKV()
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    await engine.enqueue('order', { total: 1 })
    await engine.enqueue('shift_close', { closingCash: 0 })
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(sent).toEqual([['order', 'shift_close'], ['order']]) // the close was never sent alone
    expect(engine.outbox.all().map((i) => [i.type, i.status])).toEqual([['order', 'failed'], ['shift_close', 'pending']])
  })

  it('still isolates a permanent refusal and continues to the next item', async () => {
    const sent: string[][] = []
    const request = vi.fn(async (_m: string, _p: string, body: Body) => {
      sent.push(body.items.map((i) => i.type))
      if (body.items.length > 1) throw Object.assign(new Error('bad request'), { status: 400, kind: 'http' })
      const [it] = body.items
      if (it.type === 'order') throw Object.assign(new Error('malformed'), { status: 400, kind: 'http' })
      return { data: { processed: 1, version: 0, results: [{ idempotencyKey: it.idempotencyKey, status: 'ok' }] } }
    })
    const { kv } = controllableKV()
    const engine = new SyncEngine(api(request), {}, kv, { actor: null })
    await engine.enqueue('order', { total: 1 })
    await engine.enqueue('shift_close', { closingCash: 0 })
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(sent).toEqual([['order', 'shift_close'], ['order'], ['shift_close']])
    expect(engine.reviewItems()).toHaveLength(1)
  })
})
