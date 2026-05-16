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
