import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { MAX_ATTEMPTS, type OutboxItem } from './outbox'
import type { KV } from './storage'

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

it.each(['shift_open', 'shift_close'] as const)('retains whole-request rejected %s through parking, diagnostics, reconstruction and same-key retry', async (type) => {
  const error = 'HTTP 400: invalid body'
  const original: OutboxItem = {
    type, idempotencyKey: 'synthetic-device:original-shift-operation', seq: 7, status: 'pending',
    clientCreatedAt: '2026-09-15T01:23:45.000Z',
    payload: type === 'shift_open'
      ? { startingCash: null, outletName: 'Synthetic' }
      : { shiftId: 'original-shift', closingCash: null, countedByMethod: { cash: 100 } },
  }
  const store = new Map([['mandalika.pos.outbox', JSON.stringify([original])]])
  const kv: KV = { get: key => store.get(key) ?? null, set: (key, value) => { store.set(key, value) }, remove: key => { store.delete(key) }, setDurable: async (key, value) => { store.set(key, value) }, removeDurable: async key => { store.delete(key) } }
  const sent: unknown[] = []
  // Whole HTTP rejection: no per-item successes exist. Backend envelope tests run in Go.
  const api: ApiLike = { async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    expect([method, path]).toEqual(['POST', '/api/v1/sync/batch'])
    sent.push(structuredClone(body))
    throw new Error(error)
  } }
  const reconstruct = () => new SyncEngine(api, {}, kv)
  const engine = reconstruct()
  const ack = vi.spyOn(engine.outbox, 'ack'), discard = vi.spyOn(engine.outbox, 'discard')
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    await engine.flush()
    expect(engine.outbox.all()).toEqual([{ ...original, status: 'failed', attempts: n, lastError: error }])
    expect(engine.pendingCount()).toBe(n < MAX_ATTEMPTS ? 1 : 0)
    expect(engine.deadLettered()).toHaveLength(n < MAX_ATTEMPTS ? 0 : 1)
  }
  const parked = structuredClone(engine.outbox.all()), stored = store.get('mandalika.pos.outbox')
  for (let n = 0; n < 2; n++) {
    expect(JSON.parse(engine.buildFailedSyncDiagnostics())).toEqual(parked)
    expect(engine.outbox.all()).toEqual(parked)
    expect(store.get('mandalika.pos.outbox')).toBe(stored)
  }
  expect(ack).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
  const rebuilt = reconstruct()
  expect(rebuilt.outbox.all()).toEqual(parked)
  expect(rebuilt.deadLettered()).toHaveLength(1)
  expect(await rebuilt.flush()).toBeNull()
  const retryAck = vi.spyOn(rebuilt.outbox, 'ack'), retryDiscard = vi.spyOn(rebuilt.outbox, 'discard')
  rebuilt.retryFailed()
  await vi.waitFor(() => expect(sent).toHaveLength(MAX_ATTEMPTS + 1))
  await vi.waitFor(() => expect(rebuilt.outbox.all()[0]).toMatchObject({ attempts: 1, status: 'failed', lastError: error }))
  expect(rebuilt.outbox.all()).toEqual([{ ...original, status: 'failed', attempts: 1, lastError: error }])
  expect(retryAck).not.toHaveBeenCalled(); expect(retryDiscard).not.toHaveBeenCalled()
  for (const body of sent) expect(body).toEqual({ items: [{ type: original.type, idempotencyKey: original.idempotencyKey, payload: original.payload }] })
})
