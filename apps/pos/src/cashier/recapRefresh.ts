/** Run `fetch`, hand the result to `apply`; on failure retry with doubling backoff up to `maxAttempts`
 *  tries in total, then give up quietly (the recap is reloaded when the panel is next opened).
 *  Returns a cancel function: nothing is applied or retried after it. */
export function startRefresh<T>(o: {
  fetch: () => Promise<T>
  apply: (value: T) => void
  maxAttempts: number
  baseMs: number
  /** Called once when the last attempt failed (not after cancel). */
  onGiveUp?: () => void
}): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = async (n: number): Promise<void> => {
    try {
      const value = await o.fetch()
      if (!cancelled) o.apply(value)
    } catch {
      if (cancelled) return
      if (n + 1 >= o.maxAttempts) {
        o.onGiveUp?.()
        return
      }
      timer = setTimeout(() => { void attempt(n + 1) }, o.baseMs * 2 ** n)
    }
  }
  void attempt(0)
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Ordering rules for overlapping loads of one panel view (a pure state machine; the panel only wires
 *  state setters around it). Every request takes a ticket. A response applies only when no NEWER ticket
 *  has already applied, so a slow old response never overwrites newer data, yet a fresh in-flight load is
 *  never discarded merely because a refresh started after it. */
export class RecapLoadGate {
  private issued = 0
  private applied = 0
  private pending = 0
  private fresh = 0
  private lastRefresh = 0
  private lastBegin = 0
  /** Tickets up to this one predate a refresh that gave up: their data cannot be called fresh. */
  private heldAfter: number | null = null

  /** A load (shows the loading state). */
  begin(): number {
    this.pending += 1
    this.lastBegin = ++this.issued
    return this.lastBegin
  }

  /** A background refresh attempt (no loading state). */
  issue(): number {
    this.lastRefresh = ++this.issued
    return this.lastRefresh
  }

  /** A load finished: true when the loading state may clear, i.e. it is the newest load (a hung older
   *  load must not keep the skeleton up) or none is pending any more. */
  end(ticket: number): boolean {
    this.pending = Math.max(0, this.pending - 1)
    return ticket === this.lastBegin || this.pending === 0
  }

  /** Only the newest begun load may prefill the typed counts. */
  isNewestLoad(ticket: number): boolean {
    return ticket === this.lastBegin
  }

  canApply(ticket: number): boolean {
    return ticket > this.applied
  }

  /** Record an applied response; returns whether the stale banner must show for it. */
  apply(ticket: number, loadStale: boolean): boolean {
    this.applied = ticket
    const held = this.heldAfter !== null && ticket <= this.heldAfter
    if (!loadStale) {
      this.fresh = Math.max(this.fresh, ticket)
      if (!held) this.heldAfter = null
    }
    return loadStale || held
  }

  /** A refresh attempt came back: apply it, count it as covered by a newer fresh load, or retry. */
  resolveRefresh(ticket: number): 'apply' | 'covered' | 'retry' {
    if (this.canApply(ticket)) return 'apply'
    return this.fresh >= ticket ? 'covered' : 'retry'
  }

  /** The refresh gave up: true when the stale banner must show (false if newer fresh data exists). */
  giveUp(): boolean {
    if (this.fresh > this.lastRefresh) return false
    this.heldAfter = this.issued
    return true
  }
}

/** Switching to the tab that is already active changes nothing (and must not wipe its flags). */
export function switchTab<T extends string>(current: T, next: T): T | null {
  return next === current ? null : next
}

/** Rekapan and Riwayat share loading/stale/error flags: only the visible tab's loads may touch them. */
export function ownsFlags(visibleTab: string, loaderTab: string): boolean {
  return visibleTab === loaderTab
}
