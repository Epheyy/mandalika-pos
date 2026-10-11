import type { OutboxItem } from './outbox'
import { OUTBOX_KEY } from './outbox'
import type { KV } from './storage'

/** What a store found when the outbox was opened. `corrupt` carries the raw bytes so the Outbox
 *  can quarantine them before anything overwrites them (KV store only; the journal refuses instead). */
export type OutboxLoad = { kind: 'ok'; items: OutboxItem[] } | { kind: 'corrupt'; raw: string }

/** Where the Outbox persists its items. The Outbox keeps all queue logic; a store only loads once
 *  and commits durably. `commit` resolves only after the change is durable and REJECTS otherwise. */
export interface OutboxStore {
  load(): OutboxLoad
  /** `prev` is the caller's last committed view, `next` the view to make durable. */
  commit(prev: readonly OutboxItem[], next: readonly OutboxItem[]): Promise<void>
  /** Side-channel KV: the corruption quarantine/marker today, synced-refund memory for the journal. */
  readonly kv: KV
  /** Highest seq the store holds or is about to hold. The Outbox never hands out a seq at or below it.
   *  Absent on the KV store (a single writer owns the whole array). */
  maxSeq?(): number
  /** Journal only: the store's current committed view, for resyncing an Outbox whose commit was
   *  rejected or that was built before another instance's write landed. Absent on the KV store, so
   *  the KV path never reloads. */
  reload?(): OutboxItem[]
  /** Journal only: resolves when every apply queued so far has settled. */
  idle?(): Promise<void>
}

export function isOutboxStore(x: KV | OutboxStore): x is OutboxStore {
  return typeof (x as OutboxStore).load === 'function' && typeof (x as OutboxStore).commit === 'function'
}

/** Today's behaviour byte-for-byte: the whole array under one KV key. Used on web/dev, in vitest,
 *  on iOS and on shells without the native journal plugin. */
export class KVOutboxStore implements OutboxStore {
  constructor(readonly kv: KV) {}

  load(): OutboxLoad {
    const raw = this.kv.get(OUTBOX_KEY)
    if (!raw) return { kind: 'ok', items: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    return Array.isArray(parsed) ? { kind: 'ok', items: parsed as OutboxItem[] } : { kind: 'corrupt', raw }
  }

  commit(_prev: readonly OutboxItem[], next: readonly OutboxItem[]): Promise<void> {
    return this.kv.setDurable(OUTBOX_KEY, JSON.stringify(next))
  }
}
