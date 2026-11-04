import { describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, RELOAD_COOLDOWN_MS, isChunkLoadError, reloadOnceForStaleChunk } from './chunkReload'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('reloadOnceForStaleChunk', () => {
  it('reloads the first time and sets the flag', () => {
    const reload = vi.fn()
    const storage = memStorage()
    expect(reloadOnceForStaleChunk({ storage, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(Number(storage.getItem(CHUNK_RELOAD_KEY))).toBeGreaterThan(0)
  })
  it('does not loop inside the cooldown, but may reload after it', () => {
    const reload = vi.fn()
    const storage = memStorage({ [CHUNK_RELOAD_KEY]: '1000000' })
    expect(reloadOnceForStaleChunk({ storage, reload, now: () => 1_000_000 + RELOAD_COOLDOWN_MS - 1 })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(reloadOnceForStaleChunk({ storage, reload, now: () => 1_000_000 + RELOAD_COOLDOWN_MS + 1 })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('does not reload while offline (a network drop, not a stale deploy)', () => {
    const reload = vi.fn()
    expect(reloadOnceForStaleChunk({ storage: memStorage(), reload, isOnline: () => false })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
  it('does not reload when storage is unavailable or throws', () => {
    const reload = vi.fn()
    expect(reloadOnceForStaleChunk({ storage: null, reload })).toBe(false)
    const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(reloadOnceForStaleChunk({ storage: bad, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('isChunkLoadError', () => {
  it('recognises browser wordings', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a-1.js'))).toBe(true)
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })
  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false)
  })
})
