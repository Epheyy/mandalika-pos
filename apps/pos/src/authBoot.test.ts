import { describe, expect, it, vi } from 'vitest'
import { ApiError, type AuthData, type User } from '@mandalika/api'
import type { KV } from '@mandalika/sync'
import {
  bootSession,
  cacheUser,
  classifyRefreshFailure,
  clearSession,
  readCachedUser,
  REFRESH_KEY,
  USER_KEY,
} from './authBoot'

function memKV(seed: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
    setDurable: async (k, v) => void data.set(k, v),
    removeDurable: async (k) => void data.delete(k),
  }
}

const user = { id: 'u1', name: 'Kasir', outletId: 'o1' } as unknown as User
const fresh = { access: 'a2', refresh: 'r2', user } as unknown as AuthData

describe('classifyRefreshFailure', () => {
  it('treats an HTTP 401 as rejected', () => {
    expect(classifyRefreshFailure(new ApiError(401, 'unauthorized'))).toBe('rejected')
  })
  it.each([
    ['network', new ApiError(0, 'x', 'network')],
    ['timeout', new ApiError(0, 'x', 'timeout')],
    ['500', new ApiError(500, 'x')],
    ['502 invalid body', new ApiError(502, 'x', 'invalid_response')],
    ['429', new ApiError(429, 'x')],
    ['non-ApiError', new TypeError('Failed to fetch')],
  ])('treats %s as transient', (_n, err) => {
    expect(classifyRefreshFailure(err)).toBe('transient')
  })
})

describe('bootSession', () => {
  it('returns none when there is no token', async () => {
    const refresh = vi.fn()
    const r = await bootSession(memKV(), memKV(), refresh)
    expect(r).toEqual({ kind: 'none' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('on success returns the fresh session', async () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1' })
    const r = await bootSession(kv, memKV(), async () => fresh)
    expect(r).toEqual({ kind: 'signed-in', data: fresh })
  })

  it('on 401 clears the token and cached user', async () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1', [USER_KEY]: JSON.stringify(user) })
    const r = await bootSession(kv, memKV(), async () => {
      throw new ApiError(401, 'unauthorized')
    })
    expect(r).toEqual({ kind: 'rejected' })
    expect(kv.get(REFRESH_KEY)).toBeNull()
    expect(kv.get(USER_KEY)).toBeNull()
  })

  it.each([
    ['network', new ApiError(0, 'x', 'network')],
    ['timeout', new ApiError(0, 'x', 'timeout')],
    ['500', new ApiError(500, 'x')],
    ['429', new ApiError(429, 'x')],
  ])('on %s failure restores the cached user and keeps the token', async (_n, err) => {
    const kv = memKV({ [REFRESH_KEY]: 'r1', [USER_KEY]: JSON.stringify(user) })
    const r = await bootSession(kv, memKV(), async () => {
      throw err
    })
    expect(r).toEqual({ kind: 'offline', refresh: 'r1', user })
    expect(kv.get(REFRESH_KEY)).toBe('r1')
  })

  it('on transient failure with no cached user keeps the token and shows login', async () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1' })
    const r = await bootSession(kv, memKV(), async () => {
      throw new ApiError(0, 'x', 'network')
    })
    expect(r).toEqual({ kind: 'login-keep-token' })
    expect(kv.get(REFRESH_KEY)).toBe('r1')
  })

  it('ignores a corrupt cached user', async () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1', [USER_KEY]: '{not json' })
    const r = await bootSession(kv, memKV(), async () => {
      throw new ApiError(0, 'x', 'network')
    })
    expect(r).toEqual({ kind: 'login-keep-token' })
  })

  it('migrates the live localStorage token over a stale secure copy', async () => {
    const secure = memKV({ [REFRESH_KEY]: 'stale' })
    const legacy = memKV({ [REFRESH_KEY]: 'live' })
    const refresh = vi.fn(async () => fresh)
    await bootSession(secure, legacy, refresh)
    expect(refresh).toHaveBeenCalledWith('live')
    expect(secure.get(REFRESH_KEY)).toBe('live')
    expect(legacy.get(REFRESH_KEY)).toBeNull()
  })

  it('still uses the legacy token if the secure write fails (and leaves it in place)', async () => {
    const secure = memKV()
    secure.setDurable = async () => {
      throw new Error('disk full')
    }
    const legacy = memKV({ [REFRESH_KEY]: 'live' })
    const refresh = vi.fn(async () => fresh)
    await bootSession(secure, legacy, refresh)
    expect(refresh).toHaveBeenCalledWith('live')
    expect(legacy.get(REFRESH_KEY)).toBe('live')
  })

  it('does not disturb the web shell where both stores are the same KV', async () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1' })
    const refresh = vi.fn(async () => fresh)
    await bootSession(kv, kv, refresh)
    expect(refresh).toHaveBeenCalledWith('r1')
    expect(kv.get(REFRESH_KEY)).toBe('r1')
  })
})

describe('user cache', () => {
  it('round-trips and is cleared with the session', () => {
    const kv = memKV({ [REFRESH_KEY]: 'r1' })
    cacheUser(kv, user)
    expect(readCachedUser(kv)).toEqual(user)
    clearSession(kv)
    expect(readCachedUser(kv)).toBeNull()
    expect(kv.get(REFRESH_KEY)).toBeNull()
  })
})
