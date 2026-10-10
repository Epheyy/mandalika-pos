// Durable key/value storage. localStorage is synchronous, survives app
// restart, and works in both the browser and the Capacitor WebView. Phase E
// swaps the implementation for Capacitor SQLite behind this interface.

export interface KV {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  /** Awaited write that REJECTS when the value could not be stored. Reads
   *  (`get`) stay synchronous and only ever see values a durable write has
   *  committed. Use for money/stock state (the outbox). */
  setDurable(key: string, value: string): Promise<void>
  removeDurable(key: string): Promise<void>
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
  // localStorage is synchronous: a throw here (quota / private mode) is the
  // failure signal, so let it become a rejection instead of swallowing it.
  async setDurable(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value)
  }
  async removeDurable(key: string): Promise<void> {
    localStorage.removeItem(key)
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
//
// `set`/`remove` stay fire-and-forget for low-value state. `setDurable` /
// `removeDurable` await the Preferences promise FIRST and update the mirror
// only on success, so a failed write never leaves the mirror ahead of disk.
// NOTE: on Android the plugin resolves right after SharedPreferences
// `editor.apply()` (disk write is still async), so this narrows but does not
// close the process-kill window — that needs the SQLite journal (A01).

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
    // One-time migration: lift any pre-native localStorage state. A missing
    // localStorage is fine; a failed Preferences write is NOT (the app would
    // start with an empty queue), so it propagates to the caller.
    const legacy: [string, string][] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(KEY_PREFIX) || this.mem.has(k)) continue
        const v = localStorage.getItem(k)
        if (v != null) legacy.push([k, v])
      }
    } catch {
      /* no localStorage on this platform — nothing to migrate */
    }
    for (const [k, v] of legacy) await this.setDurable(k, v)
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
  async setDurable(key: string, value: string): Promise<void> {
    await this.prefs.set({ key, value })
    this.mem.set(key, value)
  }
  async removeDurable(key: string): Promise<void> {
    await this.prefs.remove({ key })
    this.mem.delete(key)
  }
}

/** @internal exported for tests */
export { CapacitorPreferencesKV }

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
  let prefs: unknown
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor.isNativePlatform()) return activeKV
    prefs = (await import('@capacitor/preferences')).Preferences
  } catch {
    return activeKV /* plugin missing / web — stay on localStorage */
  }
  // Native: a hydrate/migration failure must NOT fall back to localStorage —
  // that would start the app with an empty queue. Let it reject to the boot.
  const kv = new CapacitorPreferencesKV(prefs)
  await kv.hydrate()
  activeKV = kv
  return activeKV
}
