// Test KV whose durable writes can succeed, reject, or be held and released
// out of order. A value reaches `store` only when its durable write resolves,
// mirroring a real durable store (and the Preferences mirror rule).
import type { KV } from '../storage'

export interface HeldWrite {
  key: string
  value: string
  resolve(): void
  reject(err?: Error): void
}

export type DurableMode = 'ok' | 'reject' | 'hold'

export function controllableKV(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  const ctl = {
    mode: 'ok' as DurableMode,
    /** Per-key override of `mode` (e.g. fail only the quarantine key). */
    modeFor: undefined as ((key: string) => DurableMode | undefined) | undefined,
    held: [] as HeldWrite[],
    /** Every durable write attempted, in issue order. */
    attempts: [] as { key: string; value: string }[],
  }
  const kv: KV = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value) },
    remove: (key) => { store.delete(key) },
    setDurable: (key, value) => {
      ctl.attempts.push({ key, value })
      const mode = ctl.modeFor?.(key) ?? ctl.mode
      if (mode === 'reject') return Promise.reject(new Error('QuotaExceededError (synthetic)'))
      if (mode === 'ok') { store.set(key, value); return Promise.resolve() }
      return new Promise<void>((resolve, reject) => {
        ctl.held.push({
          key, value,
          resolve: () => { store.set(key, value); resolve() },
          reject: (err = new Error('write failed (synthetic)')) => reject(err),
        })
      })
    },
    removeDurable: (key) => { store.delete(key); return Promise.resolve() },
  }
  return { kv, store, ctl }
}
