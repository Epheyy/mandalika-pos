import { OUTBOX_QUARANTINE_PREFIX } from './outbox'
import type { KV } from './storage'

// A08: older code queued the approver PIN inside transfer_receive payloads. Besides the live queue
// (Outbox.scrubLegacySecrets) the PIN can sit in the copies the app keeps for safety: the legacy
// backup the journal takeover writes, quarantined/corrupt queue copies, and journal quarantine rows.
// They are rewritten in place where parseable and NEVER deleted; unparseable ones are left as they
// are and reported by key (never by content).

const LEGACY_BACKUP_PREFIX = 'mandalika.outbox.legacy.'
const QUARANTINE_META_PREFIX = 'quarantine.'

type Loose = Record<string, unknown>
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

/** A copy of one item without payload.pin when it is a transfer_receive that carries one, else null. */
function scrubItem(item: unknown): Loose | null {
  if (!isObj(item) || item.type !== 'transfer_receive' || !isObj(item.payload) || !('pin' in item.payload)) return null
  const { pin: _pin, ...payload } = item.payload
  void _pin
  return { ...item, payload }
}

/** The text of a stored raw queue (a JSON array of items) without any transfer_receive PIN, or null
 *  when nothing changes or the text is not a parseable item list. */
export function scrubPinFromRawQueue(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  let changed = false
  const next = parsed.map((it) => {
    const clean = scrubItem(it)
    if (clean) changed = true
    return clean ?? it
  })
  return changed ? JSON.stringify(next) : null
}

/** A journal quarantine row `{key, seq, json, at}` (json = the item text) without the PIN, or null. */
export function scrubQuarantineRow(value: string): string | null {
  let row: unknown
  try {
    row = JSON.parse(value)
  } catch {
    return null
  }
  if (!isObj(row) || typeof row.json !== 'string') return null
  let item: unknown
  try {
    item = JSON.parse(row.json)
  } catch {
    return null
  }
  const clean = scrubItem(item)
  return clean ? JSON.stringify({ ...row, json: JSON.stringify(clean) }) : null
}

export interface ScrubReport {
  scrubbed: string[]
  unparseable: string[]
}

/** Scrub every legacy-backup and corrupt-queue copy in KV. Best effort per key. */
export async function scrubQueueCopies(kv: KV): Promise<ScrubReport> {
  const report: ScrubReport = { scrubbed: [], unparseable: [] }
  for (const key of kv.keys?.() ?? []) {
    if (!key.startsWith(LEGACY_BACKUP_PREFIX) && !key.startsWith(OUTBOX_QUARANTINE_PREFIX)) continue
    const raw = kv.get(key)
    if (raw === null) continue
    const clean = scrubPinFromRawQueue(raw)
    if (clean !== null) {
      try {
        await kv.setDurable(key, clean)
        report.scrubbed.push(key)
      } catch {
        report.unparseable.push(key) // could not rewrite: left as it was, retried at the next boot
      }
    } else if (!isParseable(raw)) {
      report.unparseable.push(key)
    }
  }
  return report
}

function isParseable(raw: string): boolean {
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/** Scrub journal `quarantine.*` meta rows; returns the updated meta entries (empty = nothing to do). */
export function scrubQuarantineMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith(QUARANTINE_META_PREFIX)) continue
    const clean = scrubQuarantineRow(v)
    if (clean !== null) out[k] = clean
  }
  return out
}
