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

  ids(): Set<string> {
    return new Set(this.live(this.read()).map((e) => e.orderId))
  }
}
