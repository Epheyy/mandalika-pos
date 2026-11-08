import { describe, expect, it, vi } from 'vitest'
import { ACTIVE_TAB_LOCK, claimActiveTab, type LockManagerLike } from './tabGuard'

// A faithful-enough Web Locks fake: exclusive, FIFO queue, ifAvailable, callback result keeps the lock held.
function fakeLocks(): LockManagerLike & { release(): void; held(): boolean } {
  let held = false
  const queue: Array<() => void> = []
  let releaseCurrent: (() => void) | null = null
  const run = (cb: (lock: unknown) => unknown) => {
    held = true
    return new Promise<void>((done) => {
      releaseCurrent = () => { held = false; releaseCurrent = null; done(); queue.shift()?.() }
      void Promise.resolve(cb({ name: ACTIVE_TAB_LOCK }))
    })
  }
  return {
    request(...args: unknown[]) {
      const name = args[0]
      expect(name).toBe(ACTIVE_TAB_LOCK)
      const opts = typeof args[1] === 'function' ? {} : (args[1] as { ifAvailable?: boolean })
      const cb = (typeof args[1] === 'function' ? args[1] : args[2]) as (lock: unknown) => unknown
      if (!held) return run(cb)
      if (opts.ifAvailable) return Promise.resolve(cb(null))
      return new Promise((res) => queue.push(() => void run(cb).then(res)))
    },
    release: () => releaseCurrent?.(),
    held: () => held,
  } as LockManagerLike & { release(): void; held(): boolean }
}

describe('claimActiveTab (F22/W01)', () => {
  it('the first tab owns; a second waits and gets the app only after the first goes away', async () => {
    const locks = fakeLocks()
    const a = await claimActiveTab({ locks, native: false })
    expect(a.owner).toBe(true)
    const b = await claimActiveTab({ locks, native: false })
    expect(b.owner).toBe(false)
    const started = vi.fn()
    if (!b.owner) void b.granted.then(started)
    await Promise.resolve()
    expect(started).not.toHaveBeenCalled() // never starts a second writer while A lives
    locks.release() // tab A closes
    if (!b.owner) await b.granted
    expect(started).toHaveBeenCalledTimes(1)
    // and B now holds the lock for good: a third tab is blocked
    const c = await claimActiveTab({ locks, native: false })
    expect(c.owner).toBe(false)
  })

  it('is a no-op on Capacitor: owner, and the lock manager is never touched', async () => {
    const request = vi.fn()
    const claim = await claimActiveTab({ locks: { request } as unknown as LockManagerLike, native: true })
    expect(claim).toEqual({ owner: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('falls back to owner without Web Locks, and when the request throws or rejects', async () => {
    expect(await claimActiveTab({ locks: null, native: false })).toEqual({ owner: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing = { request: () => { throw new Error('SecurityError') } } as unknown as LockManagerLike
    expect(await claimActiveTab({ locks: throwing, native: false })).toEqual({ owner: true })
    const rejecting = { request: () => Promise.reject(new Error('nope')) } as unknown as LockManagerLike
    expect(await claimActiveTab({ locks: rejecting, native: false })).toEqual({ owner: true })
    warn.mockRestore()
  })
})

describe('claimActiveTab queued-request failure', () => {
  it('a rejected queued request leaves the second tab blocked (fail closed), never owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const locks = {
      request: (...args: unknown[]) => {
        calls += 1
        if (calls === 1) return Promise.resolve((args[2] as (l: unknown) => unknown)(null)) // ifAvailable: held elsewhere
        return Promise.reject(new Error('queue refused'))
      },
    } as unknown as LockManagerLike
    const claim = await claimActiveTab({ locks, native: false })
    expect(claim.owner).toBe(false)
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
