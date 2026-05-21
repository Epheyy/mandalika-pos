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

export const OFFLINE_NOTICE = 'Offline — menampilkan data terakhir tersinkron'
