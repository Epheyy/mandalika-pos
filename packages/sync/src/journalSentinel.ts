/** What replaces the outbox array in Preferences once the journal owns the queue (plan §3). It is
 *  deliberately NOT an array: an older bundle that reads it quarantines it and shows its corruption
 *  banner, and the login/release guards treat it as an unreadable (non-empty) queue. */
export interface JournalSentinel {
  movedTo: 'journal'
  v: number
  at: string
  count: number
  sha256: string
}

export const SENTINEL_VERSION = 1

export function makeSentinel(at: string, count: number, sha256: string): string {
  const s: JournalSentinel = { movedTo: 'journal', v: SENTINEL_VERSION, at, count, sha256 }
  return JSON.stringify(s)
}

export function parseSentinel(raw: string | null | undefined): JournalSentinel | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<JournalSentinel> | null
    if (o && typeof o === 'object' && !Array.isArray(o) && o.movedTo === 'journal') return o as JournalSentinel
  } catch {
    /* not a sentinel */
  }
  return null
}
