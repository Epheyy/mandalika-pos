import type { KV } from './storage'

/** A15: stock debits of orders the server has acknowledged but that the next pulled snapshot may not
 *  contain yet. An ack prunes the order from the outbox, and the snapshot only changes on a pull, so
 *  without this the displayed stock jumps back up between the ack and the next pull. Display-only:
 *  never read by the outbox, the journal or the release guard. Entries normally retire on the next
 *  applied pull (app start or manual resync); there is no age expiry because a clock jump could only
 *  drop a debit the snapshot may still lack (stock too HIGH). Growth is bounded by a count cap instead. */
export interface DebitLine { productId: string; variantSize: string; qty: number }
export interface SettlingEntry {
  /** The order's idempotency key. */
  key: string
  /** Envelope outlet of the order, when it had one. */
  outletId?: string
  lines: DebitLine[]
  /** Pull counter value when the ack was recorded. A pull numbered above it was sent after the ack. */
  gen: number
  at: number
}

export const SETTLING_DEBITS_KEY = 'mandalika.pos.settlingDebits'
/** Count cap. Past it the OLDEST entries are dropped (with a warning). */
export const SETTLING_DEBITS_MAX = 2000

interface State { v: 1; gen: number; applied: number; entries: SettlingEntry[] }

function isEntry(e: unknown): e is SettlingEntry {
  const x = e as SettlingEntry | null
  return !!x && typeof x.key === 'string' && typeof x.gen === 'number' && typeof x.at === 'number' &&
    Array.isArray(x.lines) && x.lines.every((l) => l && typeof l.productId === 'string' && typeof l.variantSize === 'string' && typeof l.qty === 'number')
}

/** Persisted settling-debit list plus the pull counters that retire it. In-memory state is the truth
 *  for this session; every change is written durably through the engine's own KV, in order. */
export class SettlingDebits {
  private state: State
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private kv: KV) {
    this.state = this.load()
  }

  private load(): State {
    const empty: State = { v: 1, gen: 0, applied: 0, entries: [] }
    const raw = this.kv.get(SETTLING_DEBITS_KEY)
    if (!raw) return empty
    try {
      const p = JSON.parse(raw) as Partial<State> | null
      if (p && typeof p.gen === 'number' && typeof p.applied === 'number' && Array.isArray(p.entries)) {
        return { v: 1, gen: p.gen, applied: p.applied, entries: p.entries.filter(isEntry) }
      }
    } catch {
      /* fall through to quarantine */
    }
    // Display-only state, so an unreadable blob is not fatal, but keep the bytes before a write replaces them.
    this.chain = this.kv.setDurable(`mandalika.settlingDebits.corrupt.${new Date().toISOString()}`, raw).catch(() => {})
    return empty
  }

  /** Re-read the stored state. For an engine built before its predecessor finished writing (the
   *  constructor ran too early): call after the predecessor is idle, like the outbox refresh. */
  reload(): void { this.state = this.load() }

  /** A retired engine must never write: the next engine owns the key. (Memory still works, so a dev
   *  StrictMode re-run, which revives the same instance, loses nothing: the next write stores it all.) */
  dispose(): void { this.disposed = true }
  revive(): void { this.disposed = false }

  private persist(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const body = JSON.stringify(this.state)
    const run = this.chain.then(() => this.kv.setDurable(SETTLING_DEBITS_KEY, body))
    this.chain = run.catch(() => {})
    return run
  }

  list(): SettlingEntry[] { return this.state.entries }
  isEmpty(): boolean { return this.state.entries.length === 0 }
  idle(): Promise<unknown> { return this.chain }

  /** Number the next pull and persist the counter BEFORE it is sent, so a restart never reuses a number. */
  async beginPull(): Promise<number> {
    const g = this.state.gen + 1
    this.state = { ...this.state, gen: g }
    try {
      await this.persist()
    } catch (err) {
      console.error('[sync] settling-debit counter write failed', err)
    }
    return g
  }

  /** Remember acked orders' lines (replaces the same keys) in ONE write. Rejects if the write failed; the
   *  entries are still held in memory so this session's display stays right. */
  recordMany(entries: { key: string; outletId?: string; lines: DebitLine[] }[]): Promise<void> {
    if (!entries.length) return Promise.resolve()
    const at = Date.now()
    const incoming = new Set(entries.map((e) => e.key))
    const fresh = entries.map((e): SettlingEntry => ({ ...e, gen: this.state.gen, at }))
    let next = [...this.state.entries.filter((x) => !incoming.has(x.key)), ...fresh]
    if (next.length > SETTLING_DEBITS_MAX) {
      console.warn(`[sync] settling debits over ${SETTLING_DEBITS_MAX}: dropping the oldest`)
      next = next.slice(next.length - SETTLING_DEBITS_MAX)
    }
    this.state = { ...this.state, entries: next }
    return this.persist()
  }

  record(entry: { key: string; outletId?: string; lines: DebitLine[] }): Promise<void> {
    return this.recordMany([entry])
  }

  /** A pull numbered `g` came back. False (nothing changed) when a newer pull was already applied.
   *  Otherwise retires entries recorded before `g` was sent and drops lines whose variant the new
   *  snapshot no longer has (`known` = `productId|size` keys; null skips that check). */
  applyPull(g: number, known: ReadonlySet<string> | null): boolean {
    if (g < this.state.applied) return false
    const entries = this.state.entries
      .filter((e) => e.gen >= g)
      .map((e) => (known ? { ...e, lines: e.lines.filter((l) => known.has(`${l.productId}|${l.variantSize}`)) } : e))
      .filter((e) => e.lines.length > 0)
    this.state = { ...this.state, applied: g, entries }
    this.persist().catch((err) => console.error('[sync] settling-debit retire write failed', err))
    return true
  }
}
