import { readJSON, writeJSON, type KV } from './storage'

/** Tablet-side evidence for the 12 h offline cap (A05). The server decides on the next
 *  sync; this only drives the soft block and the evidence stamped on each new item. */

/** Sales, refunds and cash in/out lock after this long without a successful online contact. */
export const OFFLINE_CAP_MS = 12 * 3_600_000
/** The status chip warns from here. */
export const OFFLINE_WARN_MS = 10 * 3_600_000
/** Persist at most this often (plus at once on the first contact after an offline period). */
export const OFFLINE_PERSIST_MS = 60_000
export const OFFLINE_CONTACT_KEY = 'mandalika.pos.offlineContact'

/** deviceAt = device clock (ms) at the last contact; at/sig = the server-signed token when the
 *  server issued one; highWater = the latest device time seen since, so a clock set back cannot
 *  shrink the elapsed time. */
export interface ContactRecord {
  v: 1
  deviceAt: number
  at?: string
  sig?: string
  highWater: number
}

export type OfflineLevel = 'unknown' | 'ok' | 'warn' | 'locked'
export interface OfflineCapState {
  level: OfflineLevel
  offlineMs: number | null
}

/** Evidence stamped on a new outbox item's envelope. */
export interface OfflineEvidence {
  contact?: { at: string; sig: string }
  contactDeviceAt: number
  offlineMs: number
}

/** Pure: how long the tablet has been offline and what that allows. `unknown` (no record,
 *  e.g. installed over OTA while offline) never blocks; the server decides. */
export function offlineCapState(nowMs: number, record: ContactRecord | null, newestCaptureMs = 0): OfflineCapState {
  if (!record) return { level: 'unknown', offlineMs: null }
  const high = Math.max(record.highWater, newestCaptureMs, nowMs)
  const offlineMs = Math.max(0, high - record.deviceAt)
  const level: OfflineLevel = offlineMs >= OFFLINE_CAP_MS ? 'locked' : offlineMs >= OFFLINE_WARN_MS ? 'warn' : 'ok'
  return { level, offlineMs }
}

function isRecord(v: unknown): v is ContactRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.v === 1 && Number.isFinite(r.deviceAt) && Number.isFinite(r.highWater)
}

export class OfflineContact {
  private rec: ContactRecord | null
  private lastPersistAt = 0

  constructor(private readonly kv: KV, private readonly now: () => number = () => Date.now()) {
    const stored = readJSON<unknown>(kv, OFFLINE_CONTACT_KEY, null)
    this.rec = isRecord(stored) ? stored : null
  }

  record(): ContactRecord | null {
    return this.rec
  }

  /** A successful online contact (2xx from /sync/version or /sync/pull; never a 4xx). A
   *  token is kept verbatim; without one (pull path, old server) any previous token is dropped. */
  contact(signed?: { at: string; sig: string } | null): void {
    const t = this.now()
    const wasOffline = !this.rec || t - this.rec.deviceAt >= OFFLINE_PERSIST_MS
    const next: ContactRecord = { v: 1, deviceAt: t, highWater: t }
    if (signed?.at && signed.sig) {
      next.at = signed.at
      next.sig = signed.sig
    }
    this.rec = next
    this.persist(t, wasOffline)
  }

  /** Current state; also advances the high-water mark (persisted on the throttle). */
  state(newestCaptureMs = 0): OfflineCapState {
    this.advance(newestCaptureMs)
    return offlineCapState(this.now(), this.rec, newestCaptureMs)
  }

  /** Evidence for a new item, or null when no contact is known yet (omit the fields). */
  evidence(newestCaptureMs = 0): OfflineEvidence | null {
    if (!this.rec) return null
    const { offlineMs } = this.state(newestCaptureMs)
    const out: OfflineEvidence = { contactDeviceAt: this.rec.deviceAt, offlineMs: offlineMs ?? 0 }
    if (this.rec.at && this.rec.sig) out.contact = { at: this.rec.at, sig: this.rec.sig }
    return out
  }

  private advance(newestCaptureMs: number): void {
    if (!this.rec) return
    const t = this.now()
    const high = Math.max(this.rec.highWater, newestCaptureMs, t)
    if (high === this.rec.highWater) return
    this.rec = { ...this.rec, highWater: high }
    this.persist(t, false)
  }

  private persist(t: number, force: boolean): void {
    if (!this.rec || (!force && t - this.lastPersistAt < OFFLINE_PERSIST_MS)) return
    this.lastPersistAt = t
    try {
      writeJSON(this.kv, OFFLINE_CONTACT_KEY, this.rec)
    } catch {
      // A lost write only makes the window look older (fails closed); never block a sale on it.
    }
  }
}
