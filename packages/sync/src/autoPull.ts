// Pure timing for the POS background pull (auto-pull plan 2.3). It decides WHEN the engine should try a
// pull and never what a pull does; now/random/setTimeout are injected so tests drive it with fake timers.

export const AUTO_PULL = {
  /** Random wait after a raised wall is first seen. */
  JITTER_MIN_MS: 5_000,
  JITTER_MAX_MS: 15_000,
  /** Total wait from first detection, however often the server version rises meanwhile. */
  MAX_WAIT_MS: 120_000,
  /** Random wait after the app's gate turns idle. */
  NUDGE_MIN_MS: 2_000,
  NUDGE_MAX_MS: 5_000,
  /** Minimum gap between the starts of two auto pulls. */
  FLOOR_MS: 60_000,
  BACKOFF_BASE_MS: 30_000,
  BACKOFF_CAP_MS: 600_000,
  /** Rolling-hour ceiling on auto pulls (manual pulls are never limited). */
  HOURLY_CAP: 20,
  HOUR_MS: 3_600_000,
  /** A15 phase B 'stock' pulls (another tablet's sale, a refund): own floor, counted from the last auto pull
   *  of either kind, and their own rolling-hour cap that never spends the data budget. */
  STOCK_FLOOR_MS: 300_000,
  STOCK_HOURLY_CAP: 10,
  /** Re-check delay while a sale flush is running. */
  FLUSHING_RECHECK_MS: 3_000,
  /** No timer is ever armed longer than this (setTimeout overflows past 2^31-1 ms). */
  MAX_DELAY_MS: 3_600_000,
} as const

/** 'data' = reference data changed (wall raised, or an own-ack follow-up on an old server); 'stock' = only
 *  stock may be stale. */
export type PullKind = 'data' | 'stock'

export interface AutoPullDeps {
  now: () => number
  random: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** Called when the timer fires, with the kind it was armed for; the owner re-checks every precondition. */
  run: (kind: PullKind) => void
  log?: (message: string) => void
}

export class AutoPullScheduler {
  private timer: unknown = null
  private firstDetectAt = 0
  private timerKind: PullKind = 'data'
  private waitingKind: PullKind = 'data'
  private lastAttemptAt: Record<PullKind, number | null> = { data: null, stock: null }
  private attempts: Record<PullKind, number[]> = { data: [], stock: [] }
  private failures = 0
  private backoffAt = 0
  private suspended = false
  private waiting = false
  private capLogged: Record<PullKind, boolean> = { data: false, stock: false }

  constructor(private readonly deps: AutoPullDeps) {}

  isScheduled(): boolean { return this.timer !== null }
  /** The kind the pending timer was armed for, null when none is pending. */
  armedKind(): PullKind | null { return this.timer === null ? null : this.timerKind }
  isWaiting(): boolean { return this.waiting }
  isSuspended(): boolean { return this.suspended }
  /** The rolling-hour cap is used up (manual sync still works). */
  isCapped(kind: PullKind = 'data'): boolean {
    this.pruneAttempts(this.deps.now())
    return this.attempts[kind].length >= this.capOf(kind)
  }
  /** Epoch ms before which no auto pull may start because of failures (0 = none). */
  backoffUntil(): number { return this.backoffAt }

  /** A pull is wanted. `restart`: the server version rose again, so redo the jitter (bounded by MAX_WAIT_MS
   *  from first detection). Without it a pending timer is left alone. A 'data' want replaces a pending
   *  'stock' timer (the data floor and budget apply); a 'stock' want never downgrades a pending 'data' one. */
  wantPull(restart = false, kind: PullKind = 'data'): void {
    if (this.suspended) return
    this.waiting = false
    const now = this.deps.now()
    let target = now + this.between(AUTO_PULL.JITTER_MIN_MS, AUTO_PULL.JITTER_MAX_MS)
    if (this.timer !== null) {
      const upgrade = kind === 'data' && this.timerKind === 'stock'
      if (!restart && !upgrade) return
      this.clearTimer()
      target = Math.min(target, this.firstDetectAt + AUTO_PULL.MAX_WAIT_MS)
    } else {
      this.firstDetectAt = now
    }
    this.arm(target, kind)
  }

  /** The app's gate went busy -> idle while a pull was waiting for it. */
  nudge(): void {
    if (this.suspended || this.timer !== null || !this.waiting) return
    this.waiting = false
    const now = this.deps.now()
    this.firstDetectAt = now
    this.arm(now + this.between(AUTO_PULL.NUDGE_MIN_MS, AUTO_PULL.NUDGE_MAX_MS), this.waitingKind)
  }

  /** Check again after `ms` (e.g. a flush is running). Still honours floor, backoff and the hourly cap. */
  retryIn(ms: number, kind: PullKind = 'data'): void {
    if (this.suspended || this.timer !== null) return
    this.arm(this.deps.now() + ms, kind)
  }

  /** A pull was actually started: feeds the floor and the hourly cap of its kind. */
  attemptStarted(kind: PullKind = 'data'): void {
    const now = this.deps.now()
    this.lastAttemptAt[kind] = now
    this.attempts[kind].push(now)
    this.pruneAttempts(now)
  }

  succeeded(): void {
    this.failures = 0
    this.backoffAt = 0
    this.suspended = false
  }

  /** A transient failure: back off 30 s x 2^n, jittered to 50-100%, capped. */
  failed(): void {
    this.failures += 1
    const step = Math.min(AUTO_PULL.BACKOFF_CAP_MS, AUTO_PULL.BACKOFF_BASE_MS * 2 ** (this.failures - 1))
    this.backoffAt = this.deps.now() + step * (0.5 + 0.5 * this.deps.random())
  }

  resetBackoff(): void {
    this.failures = 0
    this.backoffAt = 0
  }

  /** A 4xx: the account/outlet is refused. Stop until resume() (a later version 2xx). */
  suspend(): void {
    this.suspended = true
    this.waiting = false
    this.clearTimer()
  }

  resume(): void { this.suspended = false }

  /** The owner could not pull because the app's gate is busy; no timer is held until nudged or re-armed. */
  markWaiting(kind: PullKind = 'data'): void {
    this.waiting = true
    this.waitingKind = kind
  }

  cancel(): void {
    this.clearTimer()
    this.waiting = false
  }

  private capOf(kind: PullKind): number {
    return kind === 'stock' ? AUTO_PULL.STOCK_HOURLY_CAP : AUTO_PULL.HOURLY_CAP
  }

  /** Earliest start allowed by the floor: data counts its own attempts, stock counts either kind. */
  private floorFor(kind: PullKind): number {
    const d = this.lastAttemptAt.data
    const st = this.lastAttemptAt.stock
    if (kind === 'data') return d === null ? 0 : d + AUTO_PULL.FLOOR_MS
    const last = d === null ? st : st === null ? d : Math.max(d, st)
    return last === null ? 0 : last + AUTO_PULL.STOCK_FLOOR_MS
  }

  private arm(target: number, kind: PullKind): void {
    const now = this.deps.now()
    this.clampToClock(now)
    this.pruneAttempts(now)
    if (this.attempts[kind].length >= this.capOf(kind)) {
      if (!this.capLogged[kind]) {
        this.capLogged[kind] = true
        this.deps.log?.(kind === 'data'
          ? `[sync] auto-pull hourly cap (${AUTO_PULL.HOURLY_CAP}) reached; manual sync still works`
          : `[sync] stock-pull hourly cap (${AUTO_PULL.STOCK_HOURLY_CAP}) reached; manual sync still works`)
      }
      return
    }
    this.capLogged[kind] = false
    const at = Math.max(target, this.floorFor(kind), this.backoffAt)
    this.timerKind = kind
    this.timer = this.deps.setTimeout(() => {
      this.timer = null
      this.deps.run(kind)
    }, Math.min(AUTO_PULL.MAX_DELAY_MS, Math.max(0, at - now)))
  }

  /** The wall clock can jump back (manual change, NTP): stored times in the future would starve the pull. */
  private clampToClock(now: number): void {
    for (const k of ['data', 'stock'] as const) {
      const last = this.lastAttemptAt[k]
      if (last !== null) this.lastAttemptAt[k] = Math.min(last, now)
      this.attempts[k] = this.attempts[k].map((t) => Math.min(t, now))
    }
    this.backoffAt = Math.min(this.backoffAt, now + AUTO_PULL.BACKOFF_CAP_MS)
    this.firstDetectAt = Math.min(this.firstDetectAt, now)
  }

  private pruneAttempts(now: number): void {
    for (const k of ['data', 'stock'] as const) this.attempts[k] = this.attempts[k].filter((t) => now - t < AUTO_PULL.HOUR_MS)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.deps.clearTimeout(this.timer)
    this.timer = null
  }

  private between(min: number, max: number): number {
    return min + this.deps.random() * (max - min)
  }
}
