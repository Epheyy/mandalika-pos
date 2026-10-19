import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Outbox, OUTBOX_CORRUPTION_MARKER_KEY, OUTBOX_QUARANTINE_PREFIX, type OutboxItem } from './outbox'
import { SyncEngine } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

const OUTBOX_KEY = 'mandalika.pos.outbox'
const stored = (store: Map<string, string>): OutboxItem[] => JSON.parse(store.get(OUTBOX_KEY) ?? '[]')
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Outbox durable add', () => {
  it('rejects a failed write and leaves no trace in memory or storage', async () => {
    const { kv, store, ctl } = controllableKV()
    const outbox = new Outbox(kv)
    ctl.mode = 'reject'
    await expect(outbox.add('order', 'dev:1', { total: 1 })).rejects.toThrow('QuotaExceeded')
    expect(outbox.all()).toEqual([])
    expect(outbox.pending()).toEqual([])
    expect(outbox.count()).toBe(0)
    expect(store.has(OUTBOX_KEY)).toBe(false)
    // The failed attempt must not burn a sequence number or poison the queue.
    ctl.mode = 'ok'
    const item = await outbox.add('order', 'dev:2', { total: 2 })
    expect(item.seq).toBe(1)
    expect(stored(store).map((i) => i.idempotencyKey)).toEqual(['dev:2'])
  })

  it('returns the existing item for a duplicate key without a second write', async () => {
    const { kv, ctl } = controllableKV()
    const outbox = new Outbox(kv)
    const first = await outbox.add('order', 'dev:1', { a: 1 })
    const again = await outbox.add('order', 'dev:1', { a: 2 })
    expect(again).toBe(first)
    expect(ctl.attempts).toHaveLength(1)
  })

  it('does not expose an item to pending() until its write has committed', async () => {
    const { kv, ctl } = controllableKV()
    ctl.mode = 'hold'
    const outbox = new Outbox(kv)
    const added = outbox.add('order', 'dev:1', {})
    await tick()
    expect(ctl.held).toHaveLength(1)
    expect(outbox.pending()).toEqual([])
    expect(outbox.all()).toEqual([])
    ctl.held[0].resolve()
    await added
    expect(outbox.pending().map((i) => i.idempotencyKey)).toEqual(['dev:1'])
  })

  it('serializes concurrent adds and an ack so stored == memory and order is preserved', async () => {
    const { kv, store, ctl } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:A', {})
    ctl.mode = 'hold'
    const b = outbox.add('order', 'dev:B', {})
    const c = outbox.add('order', 'dev:C', {})
    const ackA = outbox.ack('dev:A')
    await tick()
    // Only one whole-array write may be in flight: later ones wait their turn,
    // so they can never land before an earlier one.
    expect(ctl.held).toHaveLength(1)
    ctl.held.shift()!.resolve()
    await b
    await tick()
    expect(ctl.held).toHaveLength(1)
    ctl.held.shift()!.resolve()
    await c
    await tick()
    ctl.held.shift()!.resolve()
    await ackA
    const memory = outbox.all()
    expect(stored(store)).toEqual(memory)
    expect(memory.map((i) => [i.idempotencyKey, i.status, i.seq])).toEqual([
      ['dev:A', 'acked', 1], ['dev:B', 'pending', 2], ['dev:C', 'pending', 3],
    ])
  })

  it('keeps memory unchanged and keeps going when a best-effort ack write fails', async () => {
    const { kv, store, ctl } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:A', {})
    const before = store.get(OUTBOX_KEY)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ctl.mode = 'reject'
    await outbox.ack('dev:A') // resolves; failure is logged, not thrown
    expect(outbox.all()[0].status).toBe('pending') // memory never ahead of disk
    expect(store.get(OUTBOX_KEY)).toBe(before)
    ctl.mode = 'ok'
    await outbox.ack('dev:A')
    expect(outbox.all()[0].status).toBe('acked')
  })

  it('rejects a failed manual retry reset and leaves items parked', async () => {
    const { kv, ctl } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:A', {})
    for (let i = 0; i < 5; i++) await outbox.fail('dev:A', 'denied')
    expect(outbox.deadLettered()).toHaveLength(1)
    ctl.mode = 'reject'
    await expect(outbox.retryDeadLettered()).rejects.toThrow()
    expect(outbox.deadLettered()).toHaveLength(1)
  })
})

describe('Outbox corrupt storage', () => {
  const corrupt = '[{"idempotencyKey":"dev:1","type":"order","payload":{"total":125000'

  it('quarantines the exact bytes before any later write can overwrite them', async () => {
    const { kv, store, ctl } = controllableKV({ [OUTBOX_KEY]: corrupt })
    ctl.mode = 'hold'
    const outbox = new Outbox(kv)
    const info = outbox.corruptionInfo()!
    expect(info.quarantineKey.startsWith(OUTBOX_QUARANTINE_PREFIX)).toBe(true)
    expect(outbox.all()).toEqual([])

    const added = outbox.add('order', 'dev:new', {})
    await tick()
    // Quarantine write is in flight; the outbox key has NOT been touched.
    expect(ctl.attempts.map((a) => a.key)).toEqual([info.quarantineKey])
    expect(store.get(OUTBOX_KEY)).toBe(corrupt)

    ctl.mode = 'ok'
    ctl.held.shift()!.resolve()
    await added
    expect(store.get(info.quarantineKey)).toBe(corrupt)
    expect(stored(store).map((i) => i.idempotencyKey)).toEqual(['dev:new'])
    expect(ctl.attempts.map((a) => a.key)).toEqual([info.quarantineKey, OUTBOX_CORRUPTION_MARKER_KEY, OUTBOX_KEY])
    // The warning outlives the session: a later boot over the now-healthy queue
    // still points at the original quarantine key, and quarantines nothing new.
    const later = new Outbox(kv)
    expect(later.corruptionInfo()?.quarantineKey).toBe(info.quarantineKey)
    expect(later.all().map((i) => i.idempotencyKey)).toEqual(['dev:new'])
    expect([...store.keys()].filter((k) => k.startsWith(OUTBOX_QUARANTINE_PREFIX))).toEqual([info.quarantineKey])
  })

  it('refuses every outbox write if the quarantine copy could not be stored', async () => {
    const { kv, store, ctl } = controllableKV({ [OUTBOX_KEY]: corrupt })
    ctl.modeFor = (key) => (key.startsWith(OUTBOX_QUARANTINE_PREFIX) ? 'reject' : undefined)
    const outbox = new Outbox(kv)
    await expect(outbox.add('order', 'dev:new', {})).rejects.toThrow()
    expect(store.get(OUTBOX_KEY)).toBe(corrupt) // raw bytes never overwritten
    expect(ctl.attempts.some((a) => a.key === OUTBOX_KEY)).toBe(false)
    expect(store.has(OUTBOX_CORRUPTION_MARKER_KEY)).toBe(false)
  })

  it.each(['{}', 'null', '"x"', '7'])('treats non-array JSON %s as corrupt', async (raw) => {
    const { kv, store } = controllableKV({ [OUTBOX_KEY]: raw })
    const outbox = new Outbox(kv)
    expect(outbox.corruptionInfo()).not.toBeNull()
    await outbox.idle()
    expect(store.get(outbox.corruptionInfo()!.quarantineKey)).toBe(raw)
  })

  it('does not flag a healthy or empty queue', () => {
    expect(new Outbox(controllableKV().kv).corruptionInfo()).toBeNull()
    expect(new Outbox(controllableKV({ [OUTBOX_KEY]: '[]' }).kv).corruptionInfo()).toBeNull()
  })
})

describe('SyncEngine durable enqueue', () => {
  const makeEngine = (kv: ReturnType<typeof controllableKV>['kv']) => {
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    const onOutboxChange = vi.fn()
    return { engine: new SyncEngine({ request }, { onOutboxChange }, kv, { actor: null }), request, onOutboxChange }
  }
  type Body = { items: { idempotencyKey: string }[] }
  const echoOk = async (_m: string, _p: string, body: Body) => ({
    data: {
      processed: body.items.length, version: 0,
      results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })),
    },
  })

  it('rejects, queues nothing, reports no change and never sends when the write fails', async () => {
    const { kv, ctl } = controllableKV()
    const { engine, request, onOutboxChange } = makeEngine(kv)
    ctl.mode = 'reject'
    await expect(engine.enqueue('order', { total: 1 })).rejects.toThrow('QuotaExceeded')
    expect(engine.outbox.all()).toEqual([])
    expect(onOutboxChange).not.toHaveBeenCalled()
    await engine.flush()
    expect(request).not.toHaveBeenCalled()
  })

  it('a flush started while an add is in flight does not send that item', async () => {
    const { kv, ctl } = controllableKV()
    const { engine, request } = makeEngine(kv)
    request.mockImplementation(echoOk)
    ctl.mode = 'hold'
    const pendingEnqueue = engine.enqueue('order', { total: 1 })
    await tick()
    expect(await engine.flush()).toBeNull()
    expect(request).not.toHaveBeenCalled()
    ctl.mode = 'ok'
    ctl.held.shift()!.resolve()
    const { idempotencyKey } = await pendingEnqueue
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const sent = request.mock.calls[0][2] as Body
    expect(sent.items.map((i) => i.idempotencyKey)).toEqual([idempotencyKey])
  })

  it('settles a whole batch of results with one write', async () => {
    const { kv, ctl } = controllableKV()
    const { engine, request } = makeEngine(kv)
    for (let i = 0; i < 5; i++) await engine.outbox.add('order', `dev:${i}`, {})
    request.mockImplementation(echoOk)
    const outboxWrites = () => ctl.attempts.filter((w) => w.key === OUTBOX_KEY).length
    const before = outboxWrites()
    await engine.flush()
    // settle(ack x5) + prune = 2 whole-array outbox writes, not 5 + 1 (A15's settling-debit write is a separate key).
    expect(outboxWrites() - before).toBe(2)
    // ...and the 5 acked orders produce ONE settling-debit write, not one each.
    expect(ctl.attempts.filter((w) => w.key === 'mandalika.pos.settlingDebits').length).toBe(1)
    expect(engine.outbox.all()).toEqual([])
  })

  it('transfer receive: a failed write adds no credit; a success adds exactly one', async () => {
    const { kv, ctl } = controllableKV()
    const { engine } = makeEngine(kv)
    const input = {
      orderUuid: 'o-1', transferId: 't1', approvalGrantId: 'g1',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }],
    }
    ctl.mode = 'reject'
    await expect(engine.enqueueTransferReceive(input)).rejects.toThrow()
    expect(engine.pending.list()).toEqual([])
    expect(engine.outbox.all()).toEqual([])
    ctl.mode = 'ok'
    const { idempotencyKey } = await engine.enqueueTransferReceive(input)
    expect(engine.pending.list().map((c) => c.idempotencyKey)).toEqual([idempotencyKey])
    expect(engine.outbox.all().map((i) => i.idempotencyKey)).toEqual([idempotencyKey])
  })

  it('exposes the quarantine through outboxCorruption()', () => {
    const { kv } = controllableKV({ [OUTBOX_KEY]: '{not json' })
    const { engine } = makeEngine(kv)
    expect(engine.outboxCorruption()?.quarantineKey.startsWith(OUTBOX_QUARANTINE_PREFIX)).toBe(true)
  })
})

describe('Outbox ack carries the server id (A41)', () => {
  it('stores ackedOrderId as an additive top-level field and leaves the payload untouched', async () => {
    const { kv, store } = controllableKV()
    const outbox = new Outbox(kv)
    const item = await outbox.add('order', 'dev:1', { total: 1 })
    await outbox.settle([{ key: 'dev:1', op: 'ack', orderId: 'srv-1' }])
    const [row] = stored(store)
    expect(row.status).toBe('acked')
    expect((row as OutboxItem & { ackedOrderId?: string }).ackedOrderId).toBe('srv-1')
    expect(row.payload).toEqual(item.payload)
  })

  it('an ack without an id (older server) stores no ackedOrderId', async () => {
    const { kv, store } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:1', { total: 1 })
    await outbox.settle([{ key: 'dev:1', op: 'ack' }])
    expect('ackedOrderId' in stored(store)[0]).toBe(false)
  })
})
