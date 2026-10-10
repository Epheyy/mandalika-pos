import { ApiError, type AuthData, type User } from '@mandalika/api'
import type { KV } from '@mandalika/sync'

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
  | { kind: 'login-keep-token' }
  | { kind: 'rejected' }

/**
 * Before the secure KV existed the live (rotated) token was written to WebView
 * localStorage, leaving a stale copy in Preferences. When the active KV is not
 * localStorage itself, the localStorage token is the current one: move it over
 * the stale copy, then drop it. Returns the token to use.
 */
async function adoptLegacyToken(kv: KV, legacy: KV): Promise<string | null> {
  if (kv === legacy) return kv.get(REFRESH_KEY)
  const live = legacy.get(REFRESH_KEY)
  if (!live) return kv.get(REFRESH_KEY)
  try {
    await kv.setDurable(REFRESH_KEY, live)
    legacy.remove(REFRESH_KEY)
  } catch {
    /* secure write failed: keep the localStorage copy and retry next boot */
  }
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
      clearSession(kv)
      return { kind: 'rejected' }
    }
    const user = readCachedUser(kv)
    return user ? { kind: 'offline', refresh: token, user } : { kind: 'login-keep-token' }
  }
}
