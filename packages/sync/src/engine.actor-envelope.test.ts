import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_PROBLEM_MESSAGE, ENVELOPE_REFUSED_MESSAGE, SyncEngine, type ActorContext, type ApiLike } from './engine'
import { summarizeQueue, type OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

type Err = Error & { status?: number; kind?: string }
const apiError = (status: number, message = 'http', kind = 'http'): Err => Object.assign(new Error(message), { status, kind })
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const okBatch = (keys: string[]) => ({
  data: { processed: keys.length, version: 0, results: keys.map((idempotencyKey) => ({ idempotencyKey, status: 'ok' })) },
})

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const actorA: ActorContext = { outletId: 'outlet-a', userId: 'user-a', shiftId: 'shift-1', appVersion: '1.5' }

function make(request: unknown, actor?: () => ActorContext | null) {
  const { kv, store, ctl } = controllableKV()
  const engine = new SyncEngine(api(request), {}, kv, { actor: actor ?? null })
  return { engine, store, ctl, kv }
}

describe('capture-time envelope (A04)', () => {
  it('stamps outlet, user, device, capture time, shift and app version at commit', async () => {
    const { engine } = make(vi.fn().mockRejectedValue(new TypeError('offline')), () => actorA)
    const { idempotencyKey } = await engine.enqueue('order', { total: 1 })
    const item = engine.outbox.all()[0]
    expect(item.idempotencyKey).toBe(idempotencyKey)
    expect(item.envelope).toEqual({
      v: 1, outletId: 'outlet-a', userId: 'user-a', deviceId: engine.deviceId,
      capturedAt: '2026-10-11T03:00:00.000Z', shiftId: 'shift-1', appVersion: '1.5',
    })
    // The same instant as the payload's own capture time; the server prefix check relies on deviceId.
    expect(item.payload.clientCreatedAt).toBe(item.envelope!.capturedAt)
    expect(idempotencyKey.startsWith(`${item.envelope!.deviceId}:`)).toBe(true)
  })

  it('omits optional fields that are unknown (offline-opened shift has no id)', async () => {
    const { engine } = make(vi.fn().mockRejectedValue(new TypeError('offline')), () => ({ outletId: 'o', userId: 'u', shiftId: null }))
    await engine.enqueue('shift_open', { startingCash: 0 })
    expect(Object.keys(engine.outbox.all()[0].envelope!).sort()).toEqual(['capturedAt', 'deviceId', 'outletId', 'userId', 'v'])
  })

  it('refuses the mutation and stores nothing when no verified identity exists', async () => {
    const request = vi.fn()
    for (const actor of [() => null, () => ({ outletId: '', userId: 'u' }), () => ({ outletId: 'o', userId: '' })]) {
      const { engine, store, ctl } = make(request, actor)
      await expect(engine.enqueue('order', { total: 1 })).rejects.toThrow(ENVELOPE_REFUSED_MESSAGE)
      await expect(engine.enqueueTransferReceive({ transferId: 't', items: [], approverUserId: 'a', pin: '1' })).rejects.toThrow(ENVELOPE_REFUSED_MESSAGE)
      expect(engine.outbox.all()).toHaveLength(0)
      expect(ctl.attempts).toHaveLength(0)
      expect(store.get('mandalika.pos.outbox')).toBeUndefined()
      expect(engine.pending.list()).toHaveLength(0) // no optimistic credit for a refused receive
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('persists the envelope and sends it as a sibling of the payload, not inside it', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('offline'))
    const { engine, store, kv } = make(request, () => actorA)
    const { idempotencyKey } = await engine.enqueue('order', { total: 5 })
    const stored = JSON.parse(store.get('mandalika.pos.outbox')!) as OutboxItem[]
    expect(stored[0].envelope).toMatchObject({ outletId: 'outlet-a', userId: 'user-a' })

    // A rebuilt engine (restart) with a DIFFERENT actor still sends the captured one.
    const sent: unknown[] = []
    const request2 = vi.fn(async (_m: string, _p: string, body?: unknown) => {
      sent.push(structuredClone(body))
      return okBatch([idempotencyKey])
    })
    const rebuilt = new SyncEngine(api(request2), {}, kv, { actor: () => ({ outletId: 'outlet-b', userId: 'user-b' }) })
    await rebuilt.flush()
    const body = sent[0] as { items: { payload: Record<string, unknown>; envelope?: Record<string, unknown> }[] }
    expect(body.items[0].envelope).toMatchObject({ outletId: 'outlet-a', userId: 'user-a', shiftId: 'shift-1' })
    expect(body.items[0].payload).not.toHaveProperty('envelope')
    expect(body.items[0].payload).toMatchObject({ total: 5 })
  })

  it('never backfills an item stored before the envelope existed', async () => {
    const legacy: OutboxItem = {
      idempotencyKey: 'dev:old', type: 'order', payload: { total: 1 }, seq: 1, status: 'pending', clientCreatedAt: '2026-10-01T00:00:00.000Z',
    }
    const { kv } = make(vi.fn())
    await kv.setDurable('mandalika.pos.outbox', JSON.stringify([legacy]))
    const sent: unknown[] = []
    const request = vi.fn(async (_m: string, _p: string, body?: unknown) => {
      sent.push(structuredClone(body))
      return okBatch(['dev:old'])
    })
    const engine = new SyncEngine(api(request), {}, kv, { actor: () => actorA })
    await engine.flush()
    expect(sent).toEqual([{ items: [{ type: 'order', idempotencyKey: 'dev:old', payload: { total: 1 } }] }])
    expect(engine.outbox.all()).toHaveLength(0) // acked and pruned, still without an envelope
  })

  it('without a configured provider (legacy callers/tests) items carry no envelope', async () => {
    const { engine } = make(vi.fn().mockRejectedValue(new TypeError('offline')))
    await engine.enqueue('order', { total: 1 })
    expect(engine.outbox.all()[0].envelope).toBeUndefined()
  })

  it('an actor_mismatch result goes to review with the server reason, never retried', async () => {
    const request = vi.fn(async (_m: string, _p: string, body?: unknown) => {
      const key = (body as { items: { idempotencyKey: string }[] }).items[0].idempotencyKey
      return {
        data: {
          processed: 0, version: 0,
          results: [{ idempotencyKey: key, status: 'error', code: 'actor_mismatch', retryable: false, error: 'Transaksi dibuat oleh akun lain' }],
        },
      }
    })
    const { engine } = make(request, () => actorA)
    await engine.enqueue('order', { total: 1 })
    await vi.waitFor(() => expect(engine.reviewItems()).toHaveLength(1))
    expect(engine.reviewItems()[0]).toMatchObject({ reviewCode: 'actor_mismatch', reviewReason: 'Transaksi dibuat oleh akun lain' })
    expect(engine.pendingCount()).toBe(0)
    expect(engine.unsettledCount()).toBe(1) // kept, never deleted
  })
})

describe('checkVersion: a 4xx is reachable plus an account problem (A04)', () => {
  it('403 no active outlet keeps the terminal Online and flags the account', async () => {
    const { engine } = make(vi.fn().mockRejectedValue(apiError(403, 'no active outlet')))
    await engine.checkVersion()
    expect(engine.isReachable()).toBe(true)
    expect(engine.accountProblem()).toBe(ACCOUNT_PROBLEM_MESSAGE)
  })

  it('a network failure or a 5xx is still unreachable and no account problem', async () => {
    for (const err of [new TypeError('Failed to fetch'), apiError(503), apiError(0, 'net', 'network'), apiError(0, 'slow', 'timeout')]) {
      const { engine } = make(vi.fn().mockRejectedValue(err))
      await engine.checkVersion()
      expect(engine.isReachable()).toBe(false)
      expect(engine.accountProblem()).toBeNull()
    }
  })

  it('a later successful check clears the account problem', async () => {
    const request = vi.fn().mockRejectedValueOnce(apiError(403)).mockResolvedValue({ data: { version: 0 } })
    const { engine } = make(request)
    await engine.checkVersion()
    expect(engine.accountProblem()).not.toBeNull()
    await engine.checkVersion()
    expect(engine.accountProblem()).toBeNull()
    expect(engine.isReachable()).toBe(true)
  })
})

describe('pendingShiftOps / unsettledCount', () => {
  it('lists unacked shift opens/closes in order and flags parked ones', async () => {
    const { engine } = make(vi.fn().mockRejectedValue(new TypeError('offline')), () => actorA)
    await engine.enqueue('order', { total: 1 })
    await engine.enqueue('shift_open', { startingCash: 1 })
    await engine.enqueue('shift_close', { shiftId: 's', closingCash: 2 })
    const ops = engine.pendingShiftOps()
    expect(ops.map((o) => [o.type, o.parked])).toEqual([['shift_open', false], ['shift_close', false]])
    expect(ops[0].payload).toMatchObject({ startingCash: 1 })
    expect(engine.unsettledCount()).toBe(3)
    await engine.outbox.settle([{ key: ops[0].idempotencyKey, op: 'review', code: 'conflict', reason: 'x' }])
    expect(engine.pendingShiftOps().map((o) => [o.type, o.parked])).toEqual([['shift_open', true], ['shift_close', false]])
    expect(engine.unsettledCount()).toBe(3) // parked items still block releasing the terminal
    await engine.outbox.settle([{ key: ops[1].idempotencyKey, op: 'ack' }])
    expect(engine.pendingShiftOps()).toHaveLength(1)
    expect(engine.unsettledCount()).toBe(2)
  })
})

describe('summarizeQueue / foreign parked items (A04 H1)', () => {
  const stamped = (userId: string) => ({ v: 1, outletId: 'o', userId, deviceId: 'd', capturedAt: 'x' })
  const parked = { status: 'failed', attempts: 5 }

  it('classifies pending, stamped-parked and unstamped-parked, ignoring acked', () => {
    const s = summarizeQueue([
      { status: 'pending' },
      { status: 'failed', attempts: 2, envelope: stamped('a') }, // still retrying, not parked
      { ...parked, envelope: stamped('a') },
      { ...parked, envelope: stamped('b') },
      { ...parked },
      { status: 'acked', envelope: stamped('z') },
    ])
    expect(s).toMatchObject({ pending: 2, parkedStamped: 2, parkedUnstamped: 1 })
    expect(s.owners.sort()).toEqual(['a', 'b'])
    expect(summarizeQueue([])).toEqual({ pending: 0, parkedStamped: 0, parkedUnstamped: 0, owners: [] })
  })

  it('a junk entry is never treated as empty', () => {
    expect(summarizeQueue([null as never]).pending).toBe(1)
  })

  it('retryFailed re-queues only the current account\'s and unstamped parked items', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('offline'))
    const { engine } = make(request, () => ({ outletId: 'o', userId: 'me' }))
    const add = (key: string, userId?: string) => engine.outbox.add('order', key, { total: 1 }, userId ? { ...stamped(userId) } as never : undefined)
    await add('d:mine', 'me'); await add('d:theirs', 'other'); await add('d:legacy')
    await engine.outbox.settle(['d:mine', 'd:theirs', 'd:legacy'].map((key) => ({ key, op: 'review' as const, code: 'actor_mismatch', reason: 'x' })))
    expect(engine.reviewItems().map((r) => [r.idempotencyKey, r.ownerUserId])).toEqual([['d:mine', 'me'], ['d:theirs', 'other'], ['d:legacy', undefined]])
    await engine.retryFailed()
    expect(engine.reviewItems().map((r) => r.idempotencyKey)).toEqual(['d:theirs'])
    expect(engine.queueSummary()).toMatchObject({ pending: 2, parkedStamped: 1, parkedUnstamped: 0 })
  })

  it('a foreign parked item never blocks the current account\'s own item from being sent', async () => {
    const sent: string[] = []
    const request = vi.fn(async (_m: string, _p: string, body?: unknown) => {
      const keys = (body as { items: { idempotencyKey: string }[] }).items.map((i) => i.idempotencyKey)
      sent.push(...keys)
      return okBatch(keys)
    })
    const { engine } = make(request, () => ({ outletId: 'o', userId: 'me' }))
    await engine.outbox.add('order', 'd:theirs', { total: 1 }, stamped('other') as never)
    await engine.outbox.settle([{ key: 'd:theirs', op: 'review', code: 'actor_mismatch', reason: 'x' }])
    await engine.enqueue('order', { total: 2 })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).not.toBe('d:theirs')
    expect(engine.reviewItems()).toHaveLength(1)
  })
})
