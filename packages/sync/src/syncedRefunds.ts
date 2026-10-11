import { readJSON, writeJSON, type KV } from './storage'

/** Durable key: orders whose refund this tablet has seen the server acknowledge. */
export const SYNCED_REFUNDS_KEY = 'mandalika.pos.syncedRefunds'
/** Bound: newest entries only, and nothing older than the window. */
export const SYNCED_REFUNDS_MAX = 500
export const SYNCED_REFUNDS_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface Entry { orderId: string; at: number }

/** Small persistent record of acknowledged refunds. An acked refund leaves the outbox, and a cached
 *  history row can still say "completed": this keeps the refund button from coming back (a second
 *  cash payout). Best effort and bounded; the server remains the authority and refuses duplicates. */
export class SyncedRefunds {
  /** Serializes {@link addMany}: each call reads the stored list only after the previous write landed. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private kv: KV) {}

  private read(): Entry[] {
    const raw = readJSON<unknown>(this.kv, SYNCED_REFUNDS_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is Entry => !!e && typeof e.orderId === 'string' && e.orderId !== '' && typeof e.at === 'number')
  }

  private live(entries: Entry[]): Entry[] {
    const cutoff = Date.now() - SYNCED_REFUNDS_TTL_MS
    return entries.filter((e) => e.at >= cutoff).slice(-SYNCED_REFUNDS_MAX)
  }

  add(orderId: string): void {
    if (!orderId) return
    const kept = this.read().filter((e) => e.orderId !== orderId)
    writeJSON(this.kv, SYNCED_REFUNDS_KEY, this.live([...kept, { orderId, at: Date.now() }]))
  }

  /** Durably remember several orders. Resolves only once stored and REJECTS otherwise, so the caller can
   *  keep the acked refund row (the other copy of this fact) until it is safe to drop. */
  addMany(orderIds: readonly string[]): Promise<void> {
    const ids = [...new Set(orderIds.filter(Boolean))]
    if (!ids.length) return Promise.resolve()
    const run = this.chain.then(() => {
      const incoming = new Set(ids)
      const at = Date.now()
      const kept = this.read().filter((e) => !incoming.has(e.orderId))
      return this.kv.setDurable(SYNCED_REFUNDS_KEY, JSON.stringify(this.live([...kept, ...ids.map((orderId) => ({ orderId, at }))])))
    })
    this.chain = run.catch(() => {})
    return run
  }

  /** Resolves when every addMany queued so far has settled. */
  idle(): Promise<unknown> {
    return this.chain
  }

  ids(): Set<string> {
    return new Set(this.live(this.read()).map((e) => e.orderId))
  }
}
