import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { SYNCED_REFUNDS_KEY } from './syncedRefunds'
import type { OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// A41: the server's order id must survive the ack, and it must not change what the server fingerprints.

type Body = { items: { type: string; idempotencyKey: string }[] }
const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
  data: {
    processed: body.items.length, version: 0,
    results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: i.type === 'order' ? 'srv-order' : 'srv-refund' })),
  },
}))
const api: ApiLike = { request: request as unknown as ApiLike['request'] }
type Acked = OutboxItem & { ackedOrderId?: string }

beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('applyBatch passes the result id into the ack', () => {
  it('stores ackedOrderId on acked order and refund rows (kept because the refund memory write failed)', async () => {
    const { kv, store, ctl } = controllableKV()
    ctl.modeFor = (k) => (k === SYNCED_REFUNDS_KEY ? 'reject' : undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const engine = new SyncEngine(api, {}, kv, { actor: null })
    await engine.enqueue('order', { orderUuid: 'u1', total: 1 })
    await engine.enqueue('refund', { orderId: 'o1', reason: 'rusak' })
    vi.stubGlobal('navigator', { onLine: true })
    await engine.flushNow()
    const rows: Acked[] = JSON.parse(store.get('mandalika.pos.outbox') ?? '[]')
    expect(rows.map((r) => [r.type, r.status, r.ackedOrderId])).toEqual([
      ['order', 'acked', 'srv-order'],
      ['refund', 'acked', 'srv-refund'],
    ])
    // The payload the server fingerprints is exactly what was captured.
    const sent = (request.mock.calls[0][2] as unknown as { items: { payload: unknown }[] }).items
    expect(rows[0].payload).toEqual(sent[0].payload)
    expect(rows[1].payload).toEqual(sent[1].payload)
  })
})
