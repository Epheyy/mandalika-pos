// Synthetic request contract and successful memory KV for S0b tests/harness.
// This is neither a backend authorization implementation nor durable native IO.
import { SyncEngine, type ApiLike, type SyncEvents } from '../engine'
import type { OutboxItem } from '../outbox'
import type { KV } from '../storage'

export const refundPermissionError = 'Sinkronisasi refund belum selesai: izin refund pada permintaan ini tidak mencukupi. Operasi tetap tersimpan dan belum terselesaikan. Jika uang sudah dikembalikan, jangan bayar ulang.'

type Item = Pick<OutboxItem, 'type' | 'idempotencyKey' | 'payload'>

export function refundPermissionFixture(events: SyncEvents = {}) {
  const original: OutboxItem = {
    type: 'refund', idempotencyKey: 'synthetic-device:original-refund',
    payload: { orderId: 'original-sale', reason: 'sealed return',
      clientCreatedAt: '2026-09-15T01:23:45.000Z',
      capturedEvidence: { marker: 'preserve-only-what-was-captured', amount: 125000 },
    },
    seq: 42, status: 'pending', clientCreatedAt: '2026-09-15T01:23:45.000Z',
  }
  const store = new Map([['mandalika.pos.outbox', JSON.stringify([original])]])
  const kv: KV = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
    setDurable: async (key, value) => { store.set(key, value) },
    removeDurable: async (key) => { store.delete(key) },
  }
  const delivery = { permission: false, loseNextResponse: false, mutationCalls: 0 }
  const sent: Item[][] = []
  const api: ApiLike = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (method !== 'POST' || path !== '/api/v1/sync/batch') throw new Error('Unexpected synthetic request')
      const { items } = body as { items: Item[] }
      sent.push(structuredClone(items))
      const results = items.map((item) => {
        if (item.type === 'refund' && !delivery.permission) {
          return { idempotencyKey: item.idempotencyKey, status: 'error', error: refundPermissionError }
        }
        if (item.type === 'refund') delivery.mutationCalls++
        return { idempotencyKey: item.idempotencyKey, status: 'ok' }
      })
      if (delivery.loseNextResponse) {
        delivery.loseNextResponse = false
        throw new Error('Synthetic response lost after simulated commit')
      }
      return { data: { results, processed: results.filter((item) => item.status === 'ok').length, version: 0 } } as T
    },
  }
  const reconstruct = () => new SyncEngine(api, events, kv, { actor: null })
  return { original, store, kv, delivery, sent, reconstruct, engine: reconstruct() }
}
