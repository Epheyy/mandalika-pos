// Durable key/value storage. localStorage is synchronous, survives app
// restart, and works in both the browser and the Capacitor WebView. Phase E
// swaps the implementation for Capacitor SQLite behind this interface.

export interface KV {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

class LocalStorageKV implements KV {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* quota / private mode — outbox flush still works in-memory this session */
    }
  }
  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

export const defaultKV: KV = new LocalStorageKV()

export function readJSON<T>(kv: KV, key: string, fallback: T): T {
  const raw = kv.get(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJSON(kv: KV, key: string, value: unknown): void {
  kv.set(key, JSON.stringify(value))
}

// ── Secure native storage (plan §7: Capacitor secure token storage) ──────
//
// Capacitor Preferences is backed by Android SharedPreferences / iOS
// UserDefaults inside the app sandbox — not the WebView's evictable
// localStorage — so the refresh token, outbox, device id and snapshot all
// survive OS storage pressure and app restarts. The Preferences API is async
// but Outbox/Snapshot read synchronously, so we keep a hydrated in-memory
// mirror: reads are sync from the mirror, writes update the mirror and are
// flushed to Preferences fire-and-forget. On the web/dev shell this is never
// used — `defaultKV` (localStorage) stays in effect.

const KEY_PREFIX = 'mandalika.'

class CapacitorPreferencesKV implements KV {
  private mem = new Map<string, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private prefs: any) {}

  /** Load every namespaced key into the mirror before the app reads it. */
  async hydrate(): Promise<void> {
    const { keys } = await this.prefs.keys()
    for (const k of keys as string[]) {
      if (!k.startsWith(KEY_PREFIX)) continue
      const { value } = await this.prefs.get({ key: k })
      if (value != null) this.mem.set(k, value)
    }
    // One-time migration: lift any pre-native localStorage state.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(KEY_PREFIX) || this.mem.has(k)) continue
        const v = localStorage.getItem(k)
        if (v != null) {
          this.mem.set(k, v)
          void this.prefs.set({ key: k, value: v })
        }
      }
    } catch {
      /* no localStorage on this platform — nothing to migrate */
    }
  }

  get(key: string): string | null {
    return this.mem.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.mem.set(key, value)
    void this.prefs.set({ key, value })
  }
  remove(key: string): void {
    this.mem.delete(key)
    void this.prefs.remove({ key })
  }
}

let activeKV: KV = defaultKV

/** The KV every store should use. Equals `defaultKV` until `initSecureKV`. */
export function getKV(): KV {
  return activeKV
}

/**
 * On a native build, swap in Preferences-backed secure storage and hydrate
 * it. Idempotent and safe to await at app boot before auth/sync read state.
 * No-ops (keeps localStorage) on the web shell.
 */
export async function initSecureKV(): Promise<KV> {
  if (activeKV !== defaultKV) return activeKV
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor.isNativePlatform()) return activeKV
    const { Preferences } = await import('@capacitor/preferences')
    const kv = new CapacitorPreferencesKV(Preferences)
    await kv.hydrate()
    activeKV = kv
  } catch {
    /* plugin missing / web — stay on localStorage */
  }
  return activeKV
}
