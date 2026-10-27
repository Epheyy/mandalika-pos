import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACK_STORAGE_KEY, acknowledge, announceParked, announcedParkedKeys, dismissParkedAlert, nextParkedAlert, parkedSaleMessage, readAcknowledged, resetParkedAlerts, visibleReview } from './parkedSale'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  resetParkedAlerts()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  }
})
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

const base = { announced: ['a', 'b'], dismissed: new Set<string>(), acknowledged: new Set<string>(), parkedKeys: new Set(['a', 'b']), cartEmpty: true }

describe('nextParkedAlert', () => {
  it('shows the oldest announced parked key once the cart is empty', () => {
    expect(nextParkedAlert(base)).toBe('a')
  })
  it('shows nothing while a sale is in progress, then shows it when the cart empties', () => {
    expect(nextParkedAlert({ ...base, cartEmpty: false })).toBeNull()
    expect(nextParkedAlert(base)).toBe('a')
  })
  it('skips dismissed and acknowledged keys, and keys no longer parked', () => {
    expect(nextParkedAlert({ ...base, dismissed: new Set(['a']) })).toBe('b')
    expect(nextParkedAlert({ ...base, acknowledged: new Set(['a', 'b']) })).toBeNull()
    expect(nextParkedAlert({ ...base, parkedKeys: new Set(['b']) })).toBe('b')
  })
})

describe('announce / dismiss store', () => {
  it('dedupes by key: a repeated announcement yields one entry', () => {
    announceParked(['k1']); announceParked(['k1', 'k2']); announceParked(['k2'])
    expect(announcedParkedKeys()).toEqual(['k1', 'k2'])
  })
  it('a dismissed key stays dismissed when re-announced', () => {
    announceParked(['k1']); dismissParkedAlert('k1'); announceParked(['k1'])
    expect(announcedParkedKeys()).toEqual(['k1'])
    expect(nextParkedAlert({ ...base, announced: ['k1'], dismissed: new Set(['k1']), parkedKeys: new Set(['k1']) })).toBeNull()
  })
})

describe('acknowledged set', () => {
  it('persists across reads and hides rows without touching them', () => {
    acknowledge('a')
    expect([...readAcknowledged()]).toEqual(['a'])
    expect(JSON.parse(store.get(ACK_STORAGE_KEY)!)).toEqual(['a'])
    const rows = [{ idempotencyKey: 'a' }, { idempotencyKey: 'b' }]
    expect(visibleReview(rows, readAcknowledged())).toEqual([{ idempotencyKey: 'b' }])
    expect(rows).toHaveLength(2)
  })
  it('is bounded to the newest 200 keys', () => {
    for (let i = 0; i < 205; i++) acknowledge(`k${i}`)
    const set = readAcknowledged()
    expect(set.size).toBe(200)
    expect(set.has('k204')).toBe(true)
    expect(set.has('k0')).toBe(false)
  })
  it('survives unreadable storage', () => {
    store.set(ACK_STORAGE_KEY, '{not json')
    expect(readAcknowledged().size).toBe(0)
  })
})

it('uses the glossary message', () => {
  expect(parkedSaleMessage('BSD-G0007')).toBe('Transaksi #BSD-G0007 belum bisa terkirim. Hubungi admin. Transaksi aman di tablet ini.')
})
