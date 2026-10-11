import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createClient } from '@mandalika/api'
import { freshCurrentRecap, loadCurrentRecap, loadHistoricalRecap, loadRecapHistory } from './recapData'

const storage = new Map<string, string>()
let fail: string | null
let offline: boolean
const calls: string[] = []
const client = () => createClient({ baseUrl: 'http://synthetic.invalid', getToken: () => null })

beforeEach(() => {
  storage.clear(); calls.length = 0; fail = null; offline = false
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(input)
    if (offline) throw new Error('offline')
    const u = new URL(input), page = Number(u.searchParams.get('page') ?? 1), limit = Number(u.searchParams.get('limit') ?? 200)
    if (u.pathname === fail && page === 2) throw new Error('page 2 failure')
    if (u.pathname.endsWith('/current')) return new Response(JSON.stringify({ data: { id: 'current', status: 'open' } }))
    const kind = u.pathname.split('/').pop(), count = kind === 'shifts' ? 251 : 401
    const rows = Array.from({ length: count }, (_, i) => ({ id: `${kind}-${i}`, total: 1000, amount: 100, type: 'in', shiftId: u.searchParams.get('shiftId') }))
    return new Response(JSON.stringify({ data: rows.slice((page - 1) * limit, page * limit), meta: { total: count, page, limit } }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

it('loads all active orders/flows, history, and historical orders/flows with original shift filters', async () => {
  const active = await loadCurrentRecap(client())
  expect(active.data.orders).toHaveLength(401)
  expect(active.data.orders.reduce((s, o) => s + o.total, 0)).toBe(401000)
  expect(active.data.flows).toHaveLength(401)
  expect(active.data.flows.reduce((s, f) => s + f.amount, 0)).toBe(40100)
  expect((await loadRecapHistory(client())).data).toHaveLength(251)
  const past = await loadHistoricalRecap(client(), 'past & one')
  expect(past.data.orders).toHaveLength(401)
  expect(past.data.flows).toHaveLength(401)
  expect(calls.filter(s => s.includes('past%20%26%20one'))).toHaveLength(6)
  expect(calls.filter(s => s.includes('page=3'))).toHaveLength(4)
})

it.each(['/api/v1/orders', '/api/v1/cash-flows'])('retains one complete cohort after %s later-page failure and reconstructs offline', async endpoint => {
  const initial = await loadCurrentRecap(client())
  const saved = storage.get('mandalika.cache.rekap:current')
  fail = endpoint
  expect(await loadCurrentRecap(client())).toEqual({ data: initial.data, stale: true })
  expect(storage.get('mandalika.cache.rekap:current')).toBe(saved)
  offline = true
  expect(await loadCurrentRecap(client())).toEqual({ data: initial.data, stale: true })
  expect(storage.get('mandalika.cache.rekap:current')).toBe(saved)
})

it('preserves selected-shift complete orders AND flows on failure/reconstruction', async () => {
  const initial = await loadHistoricalRecap(client(), 'past')
  const saved = storage.get('mandalika.cache.rekap:orders:past')
  fail = '/api/v1/cash-flows'
  expect(await loadHistoricalRecap(client(), 'past')).toEqual({ data: initial.data, stale: true })
  expect(storage.get('mandalika.cache.rekap:orders:past')).toBe(saved)
  offline = true
  expect(await loadHistoricalRecap(client(), 'past')).toEqual({ data: initial.data, stale: true })
})

it('reconstructs the complete history from the same storage', async () => {
  const initial = await loadRecapHistory(client())
  offline = true
  expect(await loadRecapHistory(client())).toEqual({ data: initial.data, stale: true })
})

it('does not cache any prefix when the first complete fetch fails', async () => {
  fail = '/api/v1/orders'
  await expect(loadCurrentRecap(client())).rejects.toThrow('page 2 failure')
  expect(storage.size).toBe(0)
})

it('retains but never certifies a legacy potentially truncated cache', async () => {
  const legacy = JSON.stringify({ shift: { id: 'legacy' }, orders: [], flows: [] })
  storage.set('mandalika.cache.rekap:current', legacy)
  offline = true
  await expect(loadCurrentRecap(client())).rejects.toThrow('offline')
  expect(storage.get('mandalika.cache.rekap:current')).toBe(legacy)
})


it('retains a complete multi-page history on page-two failure', async () => {
  const initial = await loadRecapHistory(client())
  const saved = storage.get('mandalika.cache.rekap:history')
  fail = '/api/v1/shifts'
  expect(await loadRecapHistory(client())).toEqual({ data: initial.data, stale: true })
  expect(storage.get('mandalika.cache.rekap:history')).toBe(saved)
})

it('freshCurrentRecap rejects when the real completeRecap path fell back to the cache (stale = failure)', async () => {
  const api = client()
  await loadCurrentRecap(api) // online: fills the rekap:current cache
  offline = true
  expect((await loadCurrentRecap(api)).stale).toBe(true) // what the panel used to apply silently
  await expect(freshCurrentRecap(api)).rejects.toThrow()
  offline = false
  const fresh = await freshCurrentRecap(api)
  expect(fresh.shift?.id).toBe('current')
})
