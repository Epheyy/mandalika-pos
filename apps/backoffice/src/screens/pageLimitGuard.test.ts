import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The backend turns any `limit` above 200 into 50 (handlers.pageLimit), so a
// bigger literal silently returns 50 rows. "All rows" callers must use fetchAllPages.
const MAX_LIMIT = 200
const SRC = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('backoffice list limits', () => {
  it('never asks a list endpoint for more than the backend page cap', () => {
    const offenders: string[] = []
    for (const file of sources(decodeURIComponent(SRC))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const named = [...line.matchAll(/\blimit\s*[:=]\s*(\d+)/g)].map((m) => Number(m[1]))
        const positional = [...line.matchAll(/\bapi\.list\w+\(\s*\d+\s*,\s*(\d+)/g)].map((m) => Number(m[1]))
        if ([...named, ...positional].some((n) => n > MAX_LIMIT)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
