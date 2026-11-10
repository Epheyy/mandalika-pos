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

  // The keyset page size (1000) is a backend contract for paging=keyset only. Screens never
  // spell it out: they reach it through fetchAllByCursor (orderExportPager).
  it('keyset page size is only used through fetchAllByCursor', () => {
    const offenders: string[] = []
    for (const file of sources(decodeURIComponent(SRC))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/paging\s*:\s*['"]keyset['"]/.test(line) && !file.endsWith('ordersExportPaging.ts')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  // These endpoints return one page of at most 200 rows. Called with no arguments they
  // silently drop everything past the first page, so they must go through fetchAllPages
  // (which always passes page/limit) unless the line is deliberately single-page.
  it('never calls a capped list endpoint without paging arguments', () => {
    const offenders: string[] = []
    for (const file of sources(decodeURIComponent(SRC))) {
      readFileSync(file, 'utf8').split(String.fromCharCode(10)).forEach((line, i) => {
        if (/api\.(listProducts|listUsers|listCustomers|listStockCounts)\(\s*\)/.test(line) && !line.includes('// paged:')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
        if (/api\.(listIngredients|listIngredientStockCounts|listTransfers|listIngredientTransfers)\(\s*(\{\s*\})?\s*\)/.test(line) && !line.includes('// paged:')) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
