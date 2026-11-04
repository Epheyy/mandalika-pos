/**
 * A small TTL cache for a list that is expensive to load in full (every page of the catalogue) and is
 * the same for every screen that wants it. One entry per scope (user + outlet header); concurrent loads
 * for a scope share one request; a failed load is never cached.
 *
 * Staleness is explicit: an entry younger than the caller's `maxAgeMs` is served as is; `invalidate()`
 * marks every scope stale (the last good data stays visible while the refetch runs); `force` always loads.
 */
export interface CacheEntry<T> {
  readonly data: T
  /** `now()` when the load that produced this entry started. */
  readonly at: number
  /** The invalidation epoch the load started in; an older epoch means the entry is stale. */
  readonly epoch: number
}

export interface GetOptions {
  /** Serve a cached entry younger than this. Defaults to the cache's TTL. */
  maxAgeMs?: number
  /** Skip the cache and the in-flight request: always start a new load. */
  force?: boolean
}

export interface ScopedCache<T> {
  /** The last good entry of the CURRENT scope (stale or not), or undefined. Referentially stable until replaced. */
  peek(): CacheEntry<T> | undefined
  get(opts?: GetOptions): Promise<T>
  /** Whether the current scope has an entry younger than maxAgeMs (default: the TTL) that no invalidation has outdated. */
  fresh(maxAgeMs?: number): boolean
  /** Mark every scope stale and notify subscribers (they refetch). Last-good data stays readable. */
  invalidate(): void
  /** Drop every scope's data. */
  clear(): void
  /** The current scope's key, for effect dependencies. */
  scopeKey(): string
  /** Bumps on invalidate/clear. */
  epoch(): number
  subscribe(listener: () => void): () => void
}

export interface ScopedCacheOptions<T> {
  load: () => Promise<T>
  /** Read at request time and again when the load finishes. */
  scope: () => string
  ttlMs: number
  now?: () => number
}

export function createScopedCache<T>(options: ScopedCacheOptions<T>): ScopedCache<T> {
  const { load, scope, ttlMs } = options
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry<T>>()
  const inflight = new Map<string, { promise: Promise<T>; epoch: number }>()
  const listeners = new Set<() => void>()
  let epoch = 0

  const notify = () => listeners.forEach((l) => l())
  const isFresh = (e: CacheEntry<T>, maxAgeMs: number) => e.epoch === epoch && now() - e.at < maxAgeMs

  const startLoad = (key: string): Promise<T> => {
    const startEpoch = epoch
    const at = now()
    const promise = load().then(
      (data) => {
        // A load that straddled an outlet/user switch may mix scopes; never store it.
        if (scope() !== key) {
          // Not stored, and the slot must not keep answering later callers with this unstored list.
          if (inflight.get(key)?.promise === promise) inflight.delete(key)
          return data
        }
        // A newer load (forced, or after an invalidation) owns the slot; this one only answers its callers.
        if (inflight.get(key)?.promise !== promise) return data
        entries.set(key, { data, at, epoch: startEpoch })
        inflight.delete(key)
        notify()
        return data
      },
      (error: unknown) => {
        if (inflight.get(key)?.promise === promise) inflight.delete(key)
        throw error
      },
    )
    inflight.set(key, { promise, epoch: startEpoch })
    return promise
  }

  return {
    peek: () => entries.get(scope()),
    fresh(maxAgeMs = ttlMs) {
      const hit = entries.get(scope())
      return hit !== undefined && isFresh(hit, maxAgeMs)
    },
    get(opts = {}) {
      const key = scope()
      const maxAgeMs = opts.maxAgeMs ?? ttlMs
      if (!opts.force) {
        const hit = entries.get(key)
        if (hit && isFresh(hit, maxAgeMs)) return Promise.resolve(hit.data)
        const pending = inflight.get(key)
        // A request started before the last invalidation may carry pre-change data: do not join it.
        if (pending && pending.epoch === epoch) return pending.promise
      }
      return startLoad(key)
    },
    invalidate() {
      epoch++
      notify()
    },
    clear() {
      epoch++
      entries.clear()
      inflight.clear()
      notify()
    },
    scopeKey: scope,
    epoch: () => epoch,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
