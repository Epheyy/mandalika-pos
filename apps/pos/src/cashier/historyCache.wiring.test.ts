import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A30/A41 source-level guard: a typed history search is never cached, and boot sweeps what older builds cached.
const panel = readFileSync(new URL('./OrderHistoryPanel.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

describe('order history cache privacy wiring', () => {
  it('writes the cache only when the query has a cache key (no search term)', () => {
    expect(panel).toContain('if (cacheKey) cacheWrite(')
    expect((panel.match(/cacheWrite\(/g) ?? []).length).toBe(1)
  })

  it('sweeps the history cache at boot, after the storage is ready', () => {
    expect(main).toContain('sweepOrderHistoryCache()')
    expect(main.indexOf('await bootStorage()')).toBeLessThan(main.indexOf('sweepOrderHistoryCache()'))
  })
})
