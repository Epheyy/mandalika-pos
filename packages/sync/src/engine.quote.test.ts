import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import type { OutboxItem } from './outbox'
import type { KV } from './storage'

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

const mkKv = (store: Map<string, string>): KV => ({
  get: key => store.get(key) ?? null, set: (key, value) => { store.set(key, value) }, remove: key => { store.delete(key) },
  setDurable: async (key, value) => { store.set(key, value) }, removeDurable: async key => { store.delete(key) },
})

// A10: orders queued before the quote existed carry no quotedTotal/receiptSnapshot; the
// engine must send them byte-identical (the server then stores NULL and raises no flag).
async function flushOne(payload: Record<string, unknown>) {
  const item: OutboxItem = { type: 'order', idempotencyKey: 'dev:sale', seq: 1, status: 'pending', clientCreatedAt: '2026-10-19T01:00:00.000Z', payload }
  const store = new Map([['mandalika.pos.outbox', JSON.stringify([item])]])
  let body: unknown
  const api: ApiLike = { async request<T>(_m: string, _p: string, b?: unknown): Promise<T> {
    body = structuredClone(b)
    return { data: { processed: 1, results: [{ idempotencyKey: item.idempotencyKey, status: 'ok' }], version: 0 } } as T
  } }
  const engine = new SyncEngine(api, {}, mkKv(store), { actor: null })
  await engine.flush()
  return { body: body as { items: { payload: Record<string, unknown> }[] }, sent: JSON.stringify(item.payload) }
}

it('flushes a legacy queued order with no quote byte-identical', async () => {
  const legacy = { orderUuid: 'u1', amountPaid: 100000, paymentMethod: 'cash', clientCreatedAt: '2026-10-19T01:00:00.000Z', items: [{ productId: 'p', price: 100000, quantity: 1, subtotal: 100000 }] }
  const { body, sent } = await flushOne(legacy)
  expect(JSON.stringify(body.items[0]!.payload)).toBe(sent)
  expect(body.items[0]!.payload).not.toHaveProperty('quotedTotal')
  expect(body.items[0]!.payload).not.toHaveProperty('receiptSnapshot')
})

it('sends a quoted order with its quote and snapshot unchanged', async () => {
  const snap = { v: 1, refVersion: 3, total: 100000, lines: [] }
  const { body } = await flushOne({ orderUuid: 'u2', amountPaid: 100000, paymentMethod: 'cash', quotedTotal: 100000, receiptSnapshot: snap, items: [] })
  expect(body.items[0]!.payload.quotedTotal).toBe(100000)
  expect(body.items[0]!.payload.receiptSnapshot).toEqual(snap)
})

it('exposes the reference-data version it prices against, read-only', () => {
  const store = new Map<string, string>()
  const engine = new SyncEngine({ request: async () => ({}) as never }, {}, mkKv(store), { actor: null })
  expect(engine.referenceVersion()).toBe(0)
  store.set('mandalika.pos.contentVersion', '12')
  expect(engine.referenceVersion()).toBe(12)
})
