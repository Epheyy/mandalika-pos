import { describe, it, expect } from 'vitest'
import { SettlingDebits, SETTLING_DEBITS_KEY, SETTLING_DEBITS_TTL_MS } from './settlingDebits'
import type { KV } from './storage'

function memKV(): KV & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v) },
    remove: (k) => { store.delete(k) },
    setDurable: async (k, v) => { store.set(k, v) },
    removeDurable: async (k) => { store.delete(k) },
  }
}

const line = { productId: 'p1', variantSize: '10ml', qty: 2 }

describe('SettlingDebits (A15)', () => {
  it('starts empty', () => {
    const s = new SettlingDebits(memKV())
    expect(s.list()).toEqual([])
    expect(s.isEmpty()).toBe(true)
  })

  it('records an entry stamped with the current pull counter, and persists it', async () => {
    const kv = memKV()
    const s = new SettlingDebits(kv)
    await s.beginPull()
    await s.record({ key: 'k1', outletId: 'o1', lines: [line] })
    expect(s.list()).toMatchObject([{ key: 'k1', outletId: 'o1', gen: 1, lines: [line] }])
    expect(new SettlingDebits(kv).list()).toHaveLength(1) // survives restart
  })

  it('re-recording the same key replaces it (duplicate ack) and restamps', async () => {
    const s = new SettlingDebits(memKV())
    await s.record({ key: 'k1', lines: [line] })
    await s.beginPull()
    await s.record({ key: 'k1', lines: [line] })
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].gen).toBe(1)
  })

  it('retires only entries recorded before the applied pull was sent', async () => {
    const s = new SettlingDebits(memKV())
    await s.record({ key: 'before', lines: [line] }) // gen 0
    const g = await s.beginPull() // 1: sent after "before"
    await s.record({ key: 'during', lines: [line] }) // gen 1: acked while pull 1 in flight
    expect(s.applyPull(g, null)).toBe(true)
    expect(s.list().map((e) => e.key)).toEqual(['during'])
    const g2 = await s.beginPull()
    expect(s.applyPull(g2, null)).toBe(true)
    expect(s.list()).toEqual([])
  })

  it('refuses a pull older than the last applied one and keeps everything', async () => {
    const s = new SettlingDebits(memKV())
    const a = await s.beginPull()
    const b = await s.beginPull()
    await s.record({ key: 'k', lines: [line] }) // gen 2
    expect(s.applyPull(b, null)).toBe(true)
    expect(s.applyPull(a, null)).toBe(false)
    expect(s.list()).toHaveLength(1)
  })

  it('the counter never goes back after a restart', async () => {
    const kv = memKV()
    const s = new SettlingDebits(kv)
    await s.beginPull()
    await s.beginPull()
    const again = new SettlingDebits(kv)
    expect(await again.beginPull()).toBe(3)
  })

  it('drops lines whose variant is missing from the new snapshot, and empty entries', async () => {
    const s = new SettlingDebits(memKV())
    const g = await s.beginPull()
    await s.record({ key: 'b', lines: [line, { productId: 'p2', variantSize: '5ml', qty: 1 }] }) // gen 1
    await s.record({ key: 'c', lines: [{ productId: 'gone', variantSize: 'x', qty: 1 }] })
    s.applyPull(g, new Set(['p1|10ml']))
    expect(s.list().map((e) => e.key)).toEqual(['b'])
    expect(s.list()[0].lines).toEqual([line])
  })

  it('expires entries past the TTL', () => {
    const kv = memKV()
    const old = { v: 1, gen: 0, applied: 0, entries: [{ key: 'old', lines: [line], gen: 0, at: Date.now() - SETTLING_DEBITS_TTL_MS - 1 }] }
    kv.store.set(SETTLING_DEBITS_KEY, JSON.stringify(old))
    expect(new SettlingDebits(kv).list()).toEqual([])
  })

  it('quarantines unreadable bytes instead of overwriting them', async () => {
    const kv = memKV()
    kv.store.set(SETTLING_DEBITS_KEY, '{not json')
    const s = new SettlingDebits(kv)
    expect(s.list()).toEqual([])
    await s.idle()
    expect([...kv.store.keys()].some((k) => k.startsWith('mandalika.settlingDebits.corrupt.'))).toBe(true)
  })

  it('a failed durable write rejects but keeps the in-memory entry', async () => {
    const kv = memKV()
    kv.setDurable = async () => { throw new Error('disk full') }
    const s = new SettlingDebits(kv)
    await expect(s.record({ key: 'k', lines: [line] })).rejects.toThrow('disk full')
    expect(s.list()).toHaveLength(1)
  })
})
