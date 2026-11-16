import { readJSON, writeJSON, type KV } from './storage'

/** Durable key: orders whose refund this tablet has seen the server acknowledge. */
export const SYNCED_REFUNDS_KEY = 'mandalika.pos.syncedRefunds'
/** Durable key: sales whose void this tablet has seen the server acknowledge (Phase 3). Same shape and bounds as the
 *  synced-refund memory (this class, constructed with this key); NEW and additive, older bundles ignore it. */
export const SYNCED_VOIDS_KEY = 'mandalika.pos.syncedVoids'
/** Durable key: voided orders whose "Buat pengganti" sale this tablet has seen acknowledged (same class and bounds), so a
 *  stale history row cannot offer a second replacement. NEW and additive. */
export const SYNCED_REPLACEMENTS_KEY = 'mandalika.pos.syncedReplacements'
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

  constructor(private kv: KV, private key: string = SYNCED_REFUNDS_KEY) {}

  private read(): Entry[] {
    const raw = readJSON<unknown>(this.kv, this.key, [])
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
    writeJSON(this.kv, this.key, this.live([...kept, { orderId, at: Date.now() }]))
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
      return this.kv.setDurable(this.key, JSON.stringify(this.live([...kept, ...ids.map((orderId) => ({ orderId, at }))])))
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
