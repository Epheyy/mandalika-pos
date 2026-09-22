import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fetchAllPages, type ListResult } from '@mandalika/api'

// Responses emitted by the opt-in real authenticated Go/PostgreSQL harness.
// No live connection or synthetic substitution when the fixture is unavailable.
it.skipIf(!process.env.MANDALIKA_A26_PAGES)('reconstructs actual PostgreSQL handler pages with the production helper', async () => {
  type Row = { id: string; total?: number; amount?: number }
  const records = JSON.parse(readFileSync(process.env.MANDALIKA_A26_PAGES!, 'utf8')) as { name: string; total: number; pages: ListResult<Row>[] }[]
  expect(records.map(r => r.name)).toEqual(['orders-0', 'orders-51', 'orders-201', 'orders-1000', 'shifts', 'flows', 'products', 'filtered', 'empty-date', 'foreign-shift'])
  for (const record of records) {
    const rows = await fetchAllPages(async (page, limit) => {
      expect(limit).toBe(200)
      return record.pages[page - 1]
    })
    expect(rows).toHaveLength(record.total)
    expect(rows.map(r => r.id)).toEqual(record.pages.flatMap(p => p.data.map(r => r.id)))
    if (record.name.startsWith('orders-')) expect(rows.reduce((s, r) => s + r.total!, 0)).toBe(record.total * 1000)
    if (record.name === 'flows') expect(rows.reduce((s, r) => s + r.amount!, 0)).toBe(40100)
  }
})
