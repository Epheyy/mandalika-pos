import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'

const OUTBOX_KEY = 'mandalika.pos.outbox'

export type OutboxType =
  | 'order'
  | 'refund'
  | 'shift_open'
  | 'shift_close'
  | 'cash_flow'

export type OutboxStatus = 'pending' | 'sent' | 'acked' | 'failed'

export interface OutboxItem {
  /** `${deviceId}:${orderUuid}` — globally unique, server-side unique key. */
  idempotencyKey: string
  type: OutboxType
  payload: Record<string, unknown>
  seq: number
  status: OutboxStatus
  clientCreatedAt: string
  lastError?: string
}

// Append-only durable queue. Survives app restart/crash (plan §5). Ordered by
// monotonic seq; flushed one in flight at a time.
export class Outbox {
  private items: OutboxItem[]
  private seqCounter: number

  constructor(private kv: KV) {
    this.items = readJSON<OutboxItem[]>(kv, OUTBOX_KEY, [])
    this.seqCounter = this.items.reduce((m, i) => Math.max(m, i.seq), 0)
  }

  private persist() {
    writeJSON(this.kv, OUTBOX_KEY, this.items)
  }

  add(type: OutboxType, idempotencyKey: string, payload: Record<string, unknown>): OutboxItem {
    const existing = this.items.find((i) => i.idempotencyKey === idempotencyKey)
    if (existing) return existing // never enqueue the same key twice
    const item: OutboxItem = {
      idempotencyKey,
      type,
      payload,
      seq: ++this.seqCounter,
      status: 'pending',
      clientCreatedAt: new Date().toISOString(),
    }
    this.items.push(item)
    this.persist()
    return item
  }

  /** Items still needing delivery, in submission order. */
  pending(): OutboxItem[] {
    return this.items
      .filter((i) => i.status !== 'acked')
      .sort((a, b) => a.seq - b.seq)
  }

  count(): number {
    return this.pending().length
  }

  ack(idempotencyKey: string) {
    const it = this.items.find((i) => i.idempotencyKey === idempotencyKey)
    if (it) {
      it.status = 'acked'
      this.persist()
    }
  }

  fail(idempotencyKey: string, error: string) {
    const it = this.items.find((i) => i.idempotencyKey === idempotencyKey)
    if (it) {
      it.status = 'failed'
      it.lastError = error
      this.persist()
    }
  }

  /** Drop acked rows once their canonical order is reconciled locally. */
  prune() {
    this.items = this.items.filter((i) => i.status !== 'acked')
    this.persist()
  }

  all(): readonly OutboxItem[] {
    return this.items
  }
}
