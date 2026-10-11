import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ActorContext, type ApiLike } from './engine'
import { MAX_ATTEMPTS } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// A06 slice 7 (APK 1.6): the POS must know which orders already have a refund queued or
// parked, and a parked refund must keep (and show) exactly what the cashier captured.

type Body = { items: { type: string; idempotencyKey: string; payload: unknown; envelope?: unknown }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const actor = (shiftId: string | null): ActorContext => ({ outletId: 'outlet-a', userId: 'user-a', shiftId })

const SNAPSHOT = { orderId: 'o1', reason: 'rusak', orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash', saleShiftId: 'shift-0' }

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false }) // enqueue must not auto-flush
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-11T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function make(request: unknown, shiftId: string | null = 'shift-1') {
  const { kv } = controllableKV()
  const engine = new SyncEngine(api(request), {}, kv, { actor: () => actor(shiftId) })
  return engine
}

const denyAll = () => vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: {
    processed: 0, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'ditolak', code: 'forbidden', retryable: false })),
  },
}))

describe('queuedRefundOrderIds', () => {
  it('is empty when nothing is queued', () => {
    expect(make(vi.fn()).queuedRefundOrderIds().size).toBe(0)
  })

  it('lists the order of every queued refund, and only refunds', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('refund', { ...SNAPSHOT, orderId: 'o1' })
    await engine.enqueue('refund', { ...SNAPSHOT, orderId: 'o2' })
    await engine.enqueue('order', { orderId: 'o3', total: 1 })
    expect([...engine.queuedRefundOrderIds()].sort()).toEqual(['o1', 'o2'])
  })

  it('keeps a refund parked for review (it is not settled: the money may already be out)', async () => {
    const engine = make(denyAll())
    await engine.enqueue('refund', SNAPSHOT)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(engine.reviewItems()).toHaveLength(1)
    expect([...engine.queuedRefundOrderIds()]).toEqual(['o1'])
  })

  it('drops the order once the refund is acknowledged', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok' })) },
    }))
    const engine = make(request)
    await engine.enqueue('refund', SNAPSHOT)
    expect(engine.queuedRefundOrderIds().has('o1')).toBe(true)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(engine.queuedRefundOrderIds().size).toBe(0)
  })

  it('ignores a legacy item without a usable orderId instead of throwing', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('refund', { reason: 'x' })
    expect(engine.queuedRefundOrderIds().size).toBe(0)
  })
})

describe('queuedRefunds (recap input)', () => {
  it('reports the capture-time shift, parked flag and payload of each unacknowledged refund', async () => {
    const engine = make(denyAll(), 'shift-1')
    await engine.enqueue('refund', SNAPSHOT)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('refund', { ...SNAPSHOT, orderId: 'o2' })
    const rows = engine.queuedRefunds()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ orderId: 'o1', shiftId: 'shift-1', parked: true })
    expect(rows[1]).toMatchObject({ orderId: 'o2', shiftId: 'shift-1', parked: false })
    expect(rows[0].payload).toMatchObject({ total: 225000, paymentMethod: 'cash', saleShiftId: 'shift-0' })
  })

  it('has no shift for an item captured before the shift was synced', async () => {
    const engine = make(vi.fn(), null)
    await engine.enqueue('refund', SNAPSHOT)
    expect(engine.queuedRefunds()[0].shiftId).toBeNull()
  })
})

describe('review row carries the captured payload', () => {
  it('a denied refund keeps its display snapshot on the review item', async () => {
    const engine = make(denyAll())
    await engine.enqueue('refund', SNAPSHOT)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    const [r] = engine.reviewItems()
    expect(r).toMatchObject({ type: 'refund', reviewCode: 'forbidden' })
    expect(r.payload).toMatchObject({ orderNumber: 'BSD-G0007', total: 225000, paymentMethod: 'cash' })
  })
})

describe('fingerprint rule: the queued refund payload is never rewritten', () => {
  it('sends the byte-identical payload (and key) on every retry after a refusal', async () => {
    const sent: string[] = []
    const request = vi.fn(async (_m: string, _p: string, body: Body) => {
      sent.push(JSON.stringify(body.items.map((i) => ({ k: i.idempotencyKey, p: i.payload }))))
      return {
        data: {
          processed: 0, version: 0,
          results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'sudah direfund', code: 'conflict', retryable: false })),
        },
      }
    })
    const engine = make(request)
    await engine.enqueue('refund', SNAPSHOT)
    const queued = JSON.stringify(engine.outbox.all()[0].payload)
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    expect(engine.reviewItems()).toHaveLength(1)
    expect(engine.outbox.all()[0].attempts).toBe(MAX_ATTEMPTS)
    await engine.retryFailed()
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toBe(sent[0])
    expect(JSON.parse(sent[0])[0].p).toEqual(JSON.parse(queued))
    expect(JSON.stringify(engine.outbox.all()[0].payload)).toBe(queued)
  })
})
