import { ApiError, type AuthData, type User } from '@mandalika/api'
import { defaultKV, getKV, type KV } from '@mandalika/sync'

// Refresh token lives in secure storage on native (Capacitor Preferences →
// app sandbox), localStorage on the web shell — same key, plan §7.
export const REFRESH_KEY = 'mandalika.pos.refresh'
/** Last signed-in user, so a cold start with no network can restore the session. */
export const USER_KEY = 'mandalika.pos.user'
/** Boot refresh gets its own deadline so a dead network never holds the splash. */
export const BOOT_REFRESH_TIMEOUT_MS = 15_000

/** Mirrors the silent refresh in `@mandalika/api`: only the server answering 401
 *  (the refresh endpoint's "invalid / expired / revoked") ends the session.
 *  No answer (offline, timeout), 5xx, 429 or an unparseable body say nothing about
 *  the token, so they are transient and the session is kept. */
export function classifyRefreshFailure(err: unknown): 'rejected' | 'transient' {
  return err instanceof ApiError && err.kind === 'http' && err.status === 401 ? 'rejected' : 'transient'
}

export function readCachedUser(kv: KV): User | null {
  const raw = kv.get(USER_KEY)
  if (!raw) return null
  try {
    const u = JSON.parse(raw) as User | null
    return u && typeof u === 'object' ? u : null
  } catch {
    return null
  }
}

export function cacheUser(kv: KV, user: User): void {
  kv.set(USER_KEY, JSON.stringify(user))
}

export function clearSession(kv: KV): void {
  kv.remove(REFRESH_KEY)
  kv.remove(USER_KEY)
}

export type BootResult =
  | { kind: 'none' }
  | { kind: 'signed-in'; data: AuthData }
  /** Refresh unreachable: continue offline as the cached user, token kept. */
  | { kind: 'offline'; refresh: string; user: User }
  /** Refresh unreachable and nothing cached: show Login but keep the token. */
  | { kind: 'login-keep-token'; refresh: string }
  | { kind: 'rejected' }

/** Clears the session from the active KV and, when that is the secure store, also
 *  the legacy localStorage copy so an offline logout can never be resurrected. */
export function clearAllSessions(kv: KV, legacy: KV): void {
  clearSession(kv)
  if (kv !== legacy) clearSession(legacy)
}

/** Persist a (new or rotated) session. Resolves the KV NOW, never at import:
 *  `initSecureKV()` swaps `getKV()` after this module is loaded. */
export function persistSession(d: { refresh: string; user?: User | null }): void {
  const kv = getKV()
  kv.set(REFRESH_KEY, d.refresh)
  if (d.user) cacheUser(kv, d.user)
}

export function dropSession(): void {
  clearAllSessions(getKV(), defaultKV)
}

/** Marks that the one-time localStorage → secure-KV token migration has run. */
export const MIGRATED_KEY = 'mandalika.pos.authKvMigrated'

/**
 * Before the secure KV existed the live (rotated) token was written to WebView
 * localStorage, leaving a stale copy in Preferences. Runs ONCE (marker), only
 * when the active KV is not localStorage itself:
 *  - localStorage holds a token: it is the current one; move it to the secure KV.
 *  - it holds none: any secure token is a leftover from old code (it could sign a
 *    logged-out tablet back in), so remove it.
 * After the marker exists localStorage is never read again. Returns the token to use.
 */
async function adoptLegacyToken(kv: KV, legacy: KV): Promise<string | null> {
  if (kv === legacy || kv.get(MIGRATED_KEY)) return kv.get(REFRESH_KEY)
  const live = legacy.get(REFRESH_KEY)
  if (!live) {
    try {
      await kv.removeDurable(REFRESH_KEY)
      await kv.setDurable(MIGRATED_KEY, '1')
    } catch {
      return null /* retry next boot; never trust the possibly stale secure copy */
    }
    legacy.remove(USER_KEY)
    return null
  }
  try {
    await kv.setDurable(REFRESH_KEY, live)
    await kv.setDurable(MIGRATED_KEY, '1')
  } catch {
    // Secure storage is failing. `live` is valid for this boot, but leaving it in
    // localStorage would let a later boot overwrite the rotated token with this
    // consumed one. Retire the legacy copy and mark best-effort (non-durable).
    kv.set(MIGRATED_KEY, '1')
  }
  legacy.remove(REFRESH_KEY)
  legacy.remove(USER_KEY)
  return live
}

export async function bootSession(
  kv: KV,
  legacy: KV,
  refreshFn: (token: string) => Promise<AuthData>,
): Promise<BootResult> {
  const token = await adoptLegacyToken(kv, legacy)
  if (!token) return { kind: 'none' }
  try {
    return { kind: 'signed-in', data: await refreshFn(token) }
  } catch (err) {
    if (classifyRefreshFailure(err) === 'rejected') {
      clearAllSessions(kv, legacy)
      return { kind: 'rejected' }
    }
    const user = readCachedUser(kv)
    return user ? { kind: 'offline', refresh: token, user } : { kind: 'login-keep-token', refresh: token }
  }
}
