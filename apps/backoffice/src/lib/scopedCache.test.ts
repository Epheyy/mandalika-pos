import { describe, expect, it, vi } from 'vitest'
import { createScopedCache } from './scopedCache'

const TTL = 5 * 60_000

/** A cache over a controllable clock, scope and loader. Each load answers with its own sequence number. */
function setup(over: { load?: () => Promise<string> } = {}) {
  const clock = { t: 1_000_000 }
  const scope = { key: 'u1|outlet-a' }
  let n = 0
  const load = vi.fn(over.load ?? (async () => `list-${++n}`))
  const cache = createScopedCache<string>({ load, scope: () => scope.key, ttlMs: TTL, now: () => clock.t })
  return { cache, load, clock, scope }
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('scopedCache TTL', () => {
  it('loads once, then serves the cached list while it is younger than the TTL', async () => {
    const { cache, load, clock } = setup()
    expect(await cache.get()).toBe('list-1')
    clock.t += TTL - 1
    expect(await cache.get()).toBe('list-1')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refetches once the entry is as old as the TTL', async () => {
    const { cache, load, clock } = setup()
    await cache.get()
    clock.t += TTL
    expect(await cache.get()).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('honours a shorter maxAgeMs per caller without shortening the TTL for others', async () => {
    const { cache, load, clock } = setup()
    await cache.get()
    clock.t += 90_000
    expect(await cache.get({ maxAgeMs: 60_000 })).toBe('list-2')
    expect(await cache.get()).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('force always loads, even from a fresh entry', async () => {
    const { cache, load } = setup()
    await cache.get()
    expect(await cache.get({ force: true })).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('scopedCache scope', () => {
  it('keeps one entry per scope and never answers one scope with another scope list', async () => {
    const { cache, load, scope } = setup()
    expect(await cache.get()).toBe('list-1')
    scope.key = 'u1|outlet-b'
    expect(cache.peek()).toBeUndefined()
    expect(await cache.get()).toBe('list-2')
    scope.key = 'u1|outlet-a'
    expect(cache.peek()?.data).toBe('list-1')
    expect(await cache.get()).toBe('list-1')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('treats another user on the same outlet as another scope', async () => {
    const { cache, scope } = setup()
    await cache.get()
    scope.key = 'u2|outlet-a'
    expect(cache.peek()).toBeUndefined()
    expect(await cache.get()).toBe('list-2')
  })

  it('does not store a load that finished under a different scope than it started in', async () => {
    const gate = deferred<string>()
    const { cache, scope } = setup({ load: () => gate.promise })
    const pending = cache.get()
    scope.key = 'u1|outlet-b' // the header moved while pages were still arriving
    gate.resolve('mixed-scope-list')
    expect(await pending).toBe('mixed-scope-list')
    scope.key = 'u1|outlet-a'
    expect(cache.peek()).toBeUndefined()
  })

  it('does not leave a dead in-flight slot behind a straddled load: back in the first scope the next get loads again', async () => {
    const gates = [deferred<string>()]
    const { cache, load, scope } = setup({ load: () => (load.mock.calls.length === 1 ? gates[0].promise : Promise.resolve('clean-list')) })
    const pending = cache.get()
    scope.key = 'u1|outlet-b' // the header is on another outlet when the pages finish
    gates[0].resolve('mixed-scope-list')
    await pending
    scope.key = 'u1|outlet-a' // ...and back again
    expect(cache.peek()).toBeUndefined()
    expect(await cache.get()).toBe('clean-list')
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.peek()?.data).toBe('clean-list')
  })

  it('clear() drops every scope', async () => {
    const { cache, scope } = setup()
    await cache.get()
    scope.key = 'u1|outlet-b'
    await cache.get()
    cache.clear()
    expect(cache.peek()).toBeUndefined()
    scope.key = 'u1|outlet-a'
    expect(cache.peek()).toBeUndefined()
  })
})

describe('scopedCache fresh()', () => {
  it('is true only for a current-scope entry younger than the age and not outdated by an invalidation', async () => {
    const { cache, clock, scope } = setup()
    expect(cache.fresh()).toBe(false)
    await cache.get()
    expect(cache.fresh()).toBe(true)
    clock.t += 61_000
    expect(cache.fresh(60_000)).toBe(false)
    expect(cache.fresh()).toBe(true)
    scope.key = 'u1|outlet-b'
    expect(cache.fresh()).toBe(false)
    scope.key = 'u1|outlet-a'
    cache.invalidate()
    expect(cache.fresh()).toBe(false)
  })
})

describe('scopedCache dedup', () => {
  it('shares one load between concurrent callers of the same scope', async () => {
    const gate = deferred<string>()
    const { cache, load } = setup({ load: () => gate.promise })
    const a = cache.get()
    const b = cache.get()
    gate.resolve('shared')
    expect(await Promise.all([a, b])).toEqual(['shared', 'shared'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not share a load between two scopes', async () => {
    const { cache, load, scope } = setup()
    const a = cache.get()
    scope.key = 'u1|outlet-b'
    const b = cache.get()
    await Promise.all([a, b])
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('scopedCache invalidation', () => {
  it('marks a fresh entry stale: the next get reloads, and the old list stays readable meanwhile', async () => {
    const { cache, load } = setup()
    await cache.get()
    cache.invalidate()
    expect(cache.peek()?.data).toBe('list-1')
    expect(await cache.get()).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(2)
    expect(await cache.get()).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not let a request that started before the invalidation answer a get after it', async () => {
    const loads = [deferred<string>(), deferred<string>()]
    const { cache, load } = setup({ load: () => loads[load.mock.calls.length - 1].promise })
    const before = cache.get()
    cache.invalidate() // a product was saved while the first read was in flight
    const after = cache.get()
    loads[1].resolve('after-save')
    expect(await after).toBe('after-save')
    loads[0].resolve('before-save')
    expect(await before).toBe('before-save')
    // the pre-save answer must not overwrite the post-save entry
    expect(cache.peek()?.data).toBe('after-save')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('stores a pre-invalidation answer as stale, so the next get still reloads', async () => {
    const gate = deferred<string>()
    const { cache, load } = setup({ load: () => (load.mock.calls.length === 1 ? gate.promise : Promise.resolve('fresh')) })
    const first = cache.get()
    cache.invalidate()
    gate.resolve('old')
    await first
    expect(await cache.get()).toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('notifies subscribers on a stored load, invalidate and clear, and stops after unsubscribe', async () => {
    const { cache } = setup()
    const listener = vi.fn()
    const off = cache.subscribe(listener)
    await cache.get()
    expect(listener).toHaveBeenCalledTimes(1)
    cache.invalidate()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(cache.epoch()).toBe(1)
    cache.clear()
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    cache.invalidate()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('scopedCache failures', () => {
  it('rejects, caches nothing, keeps the last good list, and the next get retries', async () => {
    let fail = false
    let n = 0
    const { cache, load, clock } = setup({ load: async () => { if (fail) throw new Error('boom'); return `list-${++n}` } })
    await cache.get()
    clock.t += TTL
    fail = true
    await expect(cache.get()).rejects.toThrow('boom')
    expect(cache.peek()?.data).toBe('list-1')
    fail = false
    expect(await cache.get()).toBe('list-2')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not keep a failed in-flight request around for the next caller', async () => {
    const first = deferred<string>()
    const { cache, load } = setup({ load: () => (load.mock.calls.length === 1 ? first.promise : Promise.resolve('ok')) })
    const failing = cache.get()
    first.reject(new Error('503'))
    await expect(failing).rejects.toThrow('503')
    expect(await cache.get()).toBe('ok')
  })
})
