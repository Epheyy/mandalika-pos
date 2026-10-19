/**
 * Tiny last-online cache for server-fetched panels (history, recap). These
 * surfaces hit live endpoints, so offline they failed with "Failed to fetch".
 * We write each successful response through to localStorage and read it back
 * when the network is down, so the cashier always sees their latest data from
 * when they were last online instead of an error.
 *
 * Per-query keys keep filtered views accurate; an extra "last" alias lets a
 * never-before-seen query still fall back to the most recent good result.
 */

const PREFIX = 'mandalika.cache.'

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write<T>(value: T, ...keys: string[]): void {
  try {
    const raw = JSON.stringify(value)
    for (const k of keys) localStorage.setItem(PREFIX + k, raw)
  } catch {
    /* quota / serialization — cache is best-effort, never throw */
  }
}

/** Persist a successful response under an exact key plus an optional alias. */
export function cacheWrite<T>(key: string, value: T, alias?: string): void {
  if (alias) write(value, key, alias)
  else write(value, key)
}

/** Read the exact key, falling back to an alias (e.g. the last good result). */
export function cacheRead<T>(key: string, alias?: string): T | null {
  return read<T>(key) ?? (alias ? read<T>(alias) : null)
}

/** Most plain day-listing pages kept in the history cache (the newest by date). */
export const ORDER_HISTORY_CACHE_MAX = 60

const HISTORY_KEY = /^orders:(bd:)?(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2}):(\d+):([\s\S]*)$/

/** Boot-time cleanup of the order-history cache (A30/A41). Removes what older builds wrote: a key per typed
 *  search term (a phone or name, with customer rows behind it) and the legacy UTC-day keys this build never
 *  reads; then trims the plain day listings to the newest {@link ORDER_HISTORY_CACHE_MAX}. The `orders:last`
 *  alias and every other cache key are left alone. Best effort: never throws. Returns how many keys it removed. */
export function sweepOrderHistoryCache(max: number = ORDER_HISTORY_CACHE_MAX): number {
  try {
    const doomed: string[] = []
    const keep: { key: string; to: string; from: string; page: number }[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i)
      if (!full || !full.startsWith(PREFIX)) continue
      const key = full.slice(PREFIX.length)
      const m = HISTORY_KEY.exec(key)
      if (!m) continue
      if (!m[1] || m[5] !== '') doomed.push(full) // legacy shape, or a search term
      else keep.push({ key: full, from: m[2], to: m[3], page: Number(m[4]) })
    }
    keep.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : a.from < b.from ? 1 : a.from > b.from ? -1 : b.page - a.page))
    for (const k of keep.slice(max)) doomed.push(k.key)
    for (const full of doomed) localStorage.removeItem(full)
    return doomed.length
  } catch {
    return 0
  }
}

export const OFFLINE_NOTICE = 'Offline — menampilkan data terakhir tersinkron'
