import { describe, it, expect, vi } from 'vitest'
import { SettlingDebits, SETTLING_DEBITS_KEY, SETTLING_DEBITS_MAX } from './settlingDebits'
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

  it('caps the count, dropping the oldest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = new SettlingDebits(memKV())
    const many = Array.from({ length: SETTLING_DEBITS_MAX + 3 }, (_, i) => ({ key: `k${i}`, lines: [line] }))
    await s.recordMany(many)
    expect(s.list()).toHaveLength(SETTLING_DEBITS_MAX)
    expect(s.list()[0].key).toBe('k3')
  })

  it('reload re-reads what another writer stored; a disposed store does not write', async () => {
    const kv = memKV()
    const a = new SettlingDebits(kv)
    const b = new SettlingDebits(kv)
    await a.record({ key: 'k', lines: [line] })
    expect(b.list()).toEqual([])
    b.reload()
    expect(b.list()).toHaveLength(1)
    a.dispose()
    const before = kv.store.get(SETTLING_DEBITS_KEY)
    await a.record({ key: 'z', lines: [line] })
    expect(kv.store.get(SETTLING_DEBITS_KEY)).toBe(before)
  })

  it('a failed counter write still numbers the pull in memory', async () => {
    const kv = memKV()
    kv.setDurable = async () => { throw new Error('disk full') }
    const s = new SettlingDebits(kv)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await s.beginPull()).toBe(1)
    expect(await s.beginPull()).toBe(2)
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

  describe('A15 phase B: stock seq', () => {
    const e = (key: string, seq?: number, seqOutlet?: string) => ({ key, lines: [line], ...(seq === undefined ? {} : { seq, seqOutlet }) })

    it('stores seq and seqOutlet, and an old blob without them still loads', async () => {
      const kv = memKV()
      const s = new SettlingDebits(kv)
      await s.record(e('k1', 11, 'A'))
      expect(s.list()[0]).toMatchObject({ seq: 11, seqOutlet: 'A' })
      expect(new SettlingDebits(kv).list()[0]).toMatchObject({ seq: 11, seqOutlet: 'A' })
      const old = { v: 1, gen: 1, applied: 0, entries: [{ key: 'old', lines: [line], gen: 1, at: 1 }] }
      kv.store.set(SETTLING_DEBITS_KEY, JSON.stringify(old))
      const back = new SettlingDebits(kv)
      expect(back.list()).toHaveLength(1)
      expect(back.list()[0].seq).toBeUndefined()
    })

    it('strips a malformed seq but keeps the debit (dropping it would err HIGH)', () => {
      const kv = memKV()
      const bad = { v: 1, gen: 0, applied: 0, entries: [
        { key: 'a', lines: [line], gen: 0, at: 1, seq: 'x', seqOutlet: 'A' },
        { key: 'b', lines: [line], gen: 0, at: 1, seq: 5 }, // seq without its outlet cannot be compared
      ] }
      kv.store.set(SETTLING_DEBITS_KEY, JSON.stringify(bad))
      const s = new SettlingDebits(kv)
      expect(s.list().map((x) => x.key)).toEqual(['a', 'b'])
      expect(s.list().every((x) => x.seq === undefined && x.seqOutlet === undefined)).toBe(true)
    })

    it('applyPull keeps a surviving entry (gen >= g) only while the pull seq is below its seq', async () => {
      const s = new SettlingDebits(memKV())
      const g = await s.beginPull()
      await s.recordMany([e('lo', 10, 'A'), e('eq', 11, 'A'), e('hi', 12, 'A')])
      expect(s.applyPull(g, null, { seq: 11, outlet: 'A' })).toBe(true)
      expect(s.list().map((x) => x.key)).toEqual(['hi'])
    })

    it('applyPull never retires by seq without a pulled seq, an entry seq, or the same outlet', async () => {
      const s = new SettlingDebits(memKV())
      const g = await s.beginPull()
      await s.recordMany([e('noseq'), e('other', 1, 'B'), e('same', 1, 'A')])
      expect(s.applyPull(g, null)).toBe(true) // no pulled seq: gen rule only
      expect(s.list().map((x) => x.key)).toEqual(['noseq', 'other', 'same'])
      const g2 = await s.beginPull()
      await s.recordMany([e('noseq'), e('other', 1, 'B'), e('same', 1, 'A')])
      s.applyPull(g2, null, { seq: 99, outlet: 'A' })
      expect(s.list().map((x) => x.key)).toEqual(['noseq', 'other']) // other outlet is never compared
    })

    it('applyPull still retires by gen when the seq says keep (seq only removes, never keeps)', async () => {
      const s = new SettlingDebits(memKV())
      await s.record(e('early', 500, 'A')) // gen 0
      const g = await s.beginPull() // sent after the ack
      expect(s.applyPull(g, null, { seq: 1, outlet: 'A' })).toBe(true)
      expect(s.list()).toEqual([])
    })

    it('retire-on-record skips an entry the snapshot already covers, and drops a same-key older entry', async () => {
      const s = new SettlingDebits(memKV())
      await s.record(e('dup')) // an earlier seq-less record of the same key
      await s.recordMany([e('in', 10, 'A'), e('dup', 11, 'A'), e('out', 12, 'A'), e('foreign', 1, 'B'), e('noseq')], { seq: 11, outlet: 'A' })
      expect(s.list().map((x) => x.key).sort()).toEqual(['foreign', 'noseq', 'out'])
    })

    it('a replaced key inherits the earlier seq when the new record has none', async () => {
      const s = new SettlingDebits(memKV())
      await s.record(e('k', 7, 'A'))
      await s.record(e('k'))
      expect(s.list()).toMatchObject([{ key: 'k', seq: 7, seqOutlet: 'A' }])
      expect(s.hasSeq('k')).toBe(true)
      expect(s.hasSeq('zzz')).toBe(false)
    })

    it('explainedCount counts same-outlet entries with lo < seq <= hi only', async () => {
      const s = new SettlingDebits(memKV())
      await s.recordMany([e('a', 5, 'A'), e('b', 6, 'A'), e('c', 7, 'A'), e('d', 6, 'B'), e('f')])
      expect(s.explainedCount('A', 5, 7)).toBe(2)
      expect(s.explainedCount('A', 4, 5)).toBe(1)
      expect(s.explainedCount('B', 5, 7)).toBe(1)
      expect(s.explainedCount('C', 0, 100)).toBe(0)
    })
  })
})
