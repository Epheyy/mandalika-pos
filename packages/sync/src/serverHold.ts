// The server's own "slow down" (Retry-After on a 429/503) and the display-only connection cause (A29).
// Pure and clock-injected so tests drive it with fake timers. Nothing here is persisted: a restart forgets
// the hold, which is safe (the server simply answers 429/503 again).

/** Why the server cannot be reached right now. Display only: gating still reads the engine's boolean `reachable`. */
export type ConnectionState = 'online' | 'no_internet' | 'server_problem'

/** Longest hold the engine honours (matches the api client's Retry-After clamp). */
export const MAX_HOLD_MS = 30 * 60_000
/** Jitter only ever adds: a share of the requested pause, capped. */
const JITTER_SHARE = 0.2
const JITTER_CAP_MS = 10_000

/** Why a shift open/close is waiting behind a retryable item (shown on the queued list; in memory only). */
export const HELD_SHIFT_REASON = 'Ditunda: menunggu transaksi sebelumnya terkirim'

export class ServerHold {
  private until = 0

  /** Extends the hold to now + retryAfterMs + jitter. A missing or non-positive value changes nothing. */
  note(retryAfterMs: unknown, now: number, random: () => number): void {
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return
    const ra = Math.min(retryAfterMs, MAX_HOLD_MS)
    const jitter = random() * Math.min(JITTER_SHARE * ra, JITTER_CAP_MS)
    this.until = Math.max(this.until, now + ra + jitter)
  }

  /** Epoch ms the hold ends; 0 when none is active. A wall clock that jumped back cannot park the tablet longer than the cap. */
  untilMs(now: number): number {
    if (this.until <= now) return 0
    this.until = Math.min(this.until, now + MAX_HOLD_MS + JITTER_CAP_MS)
    return this.until
  }

  active(now: number): boolean {
    return this.untilMs(now) > 0
  }
}

/** True when the server (or a proxy in front of it) ANSWERED with a failure: a 5xx, 429, 408, or a body we could
 *  not parse. Anything else (no answer at all) needs a probe to tell "no internet" from "server down". */
export function answeredByServer(err: unknown): boolean {
  const e = (err ?? {}) as { kind?: unknown; status?: unknown }
  if (e.kind === 'invalid_response') return true
  const status = typeof e.status === 'number' ? e.status : 0
  return status >= 500 || status === 429 || status === 408
}
