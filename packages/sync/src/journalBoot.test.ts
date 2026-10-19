import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from 'hash-wasm'
import { createFakeJournal, persistedItems, type FakeJournal } from './testFixtures/fakeJournal'
import { controllableKV } from './testFixtures/controllableKV'
import { Outbox, OUTBOX_KEY, OUTBOX_CORRUPTION_MARKER_KEY, OUTBOX_QUARANTINE_PREFIX, type OutboxItem } from './outbox'
import { JournalOutboxStore } from './journalOutboxStore'
import { KVOutboxStore } from './outboxStore'
import { adoptOutboxStore, getOutboxStore } from './storage'
import { parseSentinel } from './journalSentinel'
import { scrubPinFromRawQueue } from './scrubStoredCopies'
import {
  initJournal,
  quarantineCorruptRows,
  getJournalBootNotice,
  resetJournalBootForTests,
  LEGACY_BACKUP_PREFIX,
  TAKEOVER_KEY,
  type JournalBootResult,
} from './journalBoot'

// Phase B / T4 (plan §3): the decision table, the copy-verify-seal migration, and a crash at every
// step. The invariant under every crash: the same item set, no duplicate keys, a sentinel and a backup.

const REFUNDS_KEY = 'mandalika.pos.syncedRefunds'
const ARCHIVE_KEY = 'mandalika.pos.receiptArchive' // A41
const NOW = new Date('2026-10-11T04:00:00.000Z')

const env = { v: 1, outletId: 'out-1', userId: 'u-a', deviceId: 'd', capturedAt: 'x' }
const sale = (n: number, over: Partial<OutboxItem> = {}): OutboxItem => ({
  idempotencyKey: `d:o${n}`,
  type: 'order',
  payload: { orderId: `o${n}`, total: 10.5, drift: 0.1 + 0.2, name: 'Kopi ☕ "x"', nested: { a: [1, { b: 2 }] } },
  seq: n,
  status: 'pending',
  clientCreatedAt: '2026-10-11T00:00:00.000Z',
  envelope: env,
  ...over,
})
/** One of every shape the queue can hold. */
const variety = (): OutboxItem[] => [
  sale(1),
  sale(2, { type: 'refund', payload: { orderId: 'o1', reason: 'rusak', display: { total: 10.5 } }, status: 'acked' }),
  sale(3, { status: 'failed', attempts: 5, reviewCode: 'conflict', reviewReason: 'x', lastError: 'x' }),
  sale(4, { status: 'failed', retryableFailures: 3, lastError: 'timeout' }),
  sale(5, { type: 'transfer_receive', payload: { transferId: 't', pin: '1234' }, envelope: undefined }),
  sale(7, { type: 'cash_flow', payload: { amount: 1e21, note: ' ' } }),
]

const seedKV = (items: OutboxItem[] | string | null, extra: Record<string, string> = {}) => {
  const seed = { ...extra }
  if (items !== null) seed[OUTBOX_KEY] = typeof items === 'string' ? items : JSON.stringify(items)
  return controllableKV(seed)
}

const boot = (kv: ReturnType<typeof controllableKV>['kv'], fj: FakeJournal, extra: Record<string, unknown> = {}) =>
  initJournal({ kv, plugin: fj.plugin, isPluginAvailable: () => true, now: () => NOW, ...extra })

const journalOf = (r: JournalBootResult) => {
  if (r.kind !== 'journal') throw new Error(`expected journal, got ${r.kind}`)
  return r.store
}
const keysOf = (items: readonly OutboxItem[]) => items.map((i) => i.idempotencyKey)
const legacyKeys = (store: Map<string, string>) => [...store.keys()].filter((k) => k.startsWith(LEGACY_BACKUP_PREFIX))
const shaOf = (items: readonly OutboxItem[]) =>
  sha256([...items].sort((a, b) => a.seq - b.seq).map((i) => JSON.stringify(i)).join('\n'))

afterEach(() => {
  adoptOutboxStore(null)
  resetJournalBootForTests()
})

describe('plugin absent', () => {
  it('stays on the KV store silently (no warning) when the queue is an array', async () => {
    const { kv, store } = seedKV(variety())
    const before = store.get(OUTBOX_KEY)
    const r = await initJournal({ kv, isPluginAvailable: () => false })
    expect(r.kind).toBe('kv')
    expect(getJournalBootNotice()).toBeNull()
    expect(getOutboxStore()).toBeInstanceOf(KVOutboxStore)
    expect(store.get(OUTBOX_KEY)).toBe(before)
  })
  it('stays on the KV store when there is no queue at all', async () => {
    const { kv } = seedKV(null)
    expect((await initJournal({ kv, isPluginAvailable: () => false })).kind).toBe('kv')
  })
  it('stops when the queue already moved to the journal (app version mismatch)', async () => {
    const { kv } = seedKV(variety())
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    await expect(initJournal({ kv, isPluginAvailable: () => false })).rejects.toThrow(/tersimpan di journal; versi aplikasi tidak cocok/)
  })
})

describe('before takeover: journal unusable keeps selling on the old storage (owner Q1)', () => {
  it('open() rejects: KV store, queue untouched, warning recorded', async () => {
    const { kv, store } = seedKV(variety())
    const before = store.get(OUTBOX_KEY)
    const fj = createFakeJournal()
    fj.ctl.openError = new Error('no such table')
    const r = await boot(kv, fj)
    expect(r.kind).toBe('fallback')
    expect(store.get(OUTBOX_KEY)).toBe(before)
    expect(getOutboxStore()).toBeInstanceOf(KVOutboxStore)
    expect(getJournalBootNotice()?.code).toBe('open_failed')
  })
  it('quick_check failure falls back', async () => {
    const { kv } = seedKV(variety())
    const fj = createFakeJournal()
    fj.ctl.open = { ...fj.ctl.open, quickCheck: 'row 3 missing from index' }
    expect((await boot(kv, fj)).kind).toBe('fallback')
    expect(getJournalBootNotice()?.code).toBe('quick_check_failed')
  })
  it('synchronous below FULL falls back', async () => {
    const { kv } = seedKV(variety())
    const fj = createFakeJournal()
    fj.ctl.open = { ...fj.ctl.open, synchronous: 1 }
    expect((await boot(kv, fj)).kind).toBe('fallback')
    expect(getJournalBootNotice()?.code).toBe('not_full_sync')
  })
  it('a malformed array is not migrated: KV store + warning', async () => {
    for (const bad of [
      '[{"idempotencyKey":"d:1","seq":1},{"idempotencyKey":"d:1","seq":2}]', // duplicate key
      '[{"idempotencyKey":"d:1","seq":1},{"idempotencyKey":"d:2","seq":1}]', // duplicate seq
      '[{"seq":1}]', // no key
      '[1,2]', // not objects
      '[{"idempotencyKey":"d:1","seq":"x"}]', // seq not a number
    ]) {
      resetJournalBootForTests()
      const { kv, store } = seedKV(bad)
      const fj = createFakeJournal()
      expect((await boot(kv, fj)).kind).toBe('fallback')
      expect(store.get(OUTBOX_KEY)).toBe(bad)
      expect(fj.persisted.rows.size).toBe(0)
      expect(fj.persisted.meta.get('migration')).toBeUndefined()
      expect(getJournalBootNotice()?.code).toBe('malformed_queue')
    }
  })
  it('a retry on the next launch succeeds once the journal opens', async () => {
    const { kv, store } = seedKV(variety())
    const fj = createFakeJournal()
    fj.ctl.openError = new Error('boom')
    await boot(kv, fj)
    const next = fj.restart()
    const r = await boot(kv, next)
    expect(r.kind).toBe('journal')
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).not.toBeNull()
    expect(getJournalBootNotice()).toBeNull()
  })
})

describe('first migration: copy, verify, backup, seal', () => {
  it('moves every item byte for byte and seals Preferences with a sentinel', async () => {
    const items = variety()
    const { kv, store } = seedKV(items, { [REFUNDS_KEY]: JSON.stringify([{ orderId: 'o9', at: 5 }]) })
    const raw = store.get(OUTBOX_KEY) as string
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))

    // The journal rows are the exact JSON.stringify of each item.
    for (const it of items) expect(fj.persisted.rows.get(it.idempotencyKey)).toEqual({ seq: it.seq, json: JSON.stringify(it) })
    expect(j.load()).toEqual({ kind: 'ok', items: JSON.parse(JSON.stringify(items)) })
    expect(JSON.stringify((j.load() as { items: unknown[] }).items)).toBe(raw)
    expect(fj.persisted.meta.get('migration')).toBe('sealed')
    expect(fj.persisted.meta.get(REFUNDS_KEY)).toBe(JSON.stringify([{ orderId: 'o9', at: 5 }]))

    const s = parseSentinel(store.get(OUTBOX_KEY) ?? null)
    expect(s).toMatchObject({ movedTo: 'journal', v: 1, count: items.length, at: NOW.toISOString() })
    expect(s?.sha256).toBe(await shaOf(items))
    const backups = legacyKeys(store)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toBe(LEGACY_BACKUP_PREFIX + NOW.toISOString())
    // Verbatim except the A08 scrub, which removes a raw approver PIN from the backup copy.
    expect(store.get(backups[0])).toBe(scrubPinFromRawQueue(raw) ?? raw)
    expect(store.get(backups[0])).not.toContain('"1234"')
    expect(getOutboxStore()).toBe(j)
    expect(getJournalBootNotice()).toBeNull()
  })
  it('an absent queue seals an empty journal without a backup', async () => {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    expect(j.load()).toEqual({ kind: 'ok', items: [] })
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: 0 })
    expect(legacyKeys(store)).toHaveLength(0)
  })
  it('a non-array value is quarantined first (existing behaviour), then sealed empty', async () => {
    const { kv, store } = seedKV('{broken')
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    expect(j.load()).toEqual({ kind: 'ok', items: [] })
    const q = [...store.keys()].filter((k) => k.startsWith(OUTBOX_QUARANTINE_PREFIX))
    expect(q).toHaveLength(1)
    expect(store.get(q[0])).toBe('{broken')
    expect(store.get(OUTBOX_CORRUPTION_MARKER_KEY)).toContain(q[0])
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: 0 })
  })
  it('a verification mismatch leaves the queue where it was and the journal unadopted', async () => {
    const { kv, store } = seedKV(variety())
    const before = store.get(OUTBOX_KEY)
    const fj = createFakeJournal()
    const real = fj.plugin.readAll.bind(fj.plugin)
    let reads = 0
    fj.plugin.readAll = async () => {
      const r = await real()
      reads += 1
      // first read is the boot snapshot, the second is verification: re-space one row's JSON
      if (reads >= 2 && r.rows.length) r.rows[0] = { ...r.rows[0], json: JSON.stringify(JSON.parse(r.rows[0].json), null, 1) }
      return r
    }
    expect((await boot(kv, fj)).kind).toBe('fallback')
    expect(store.get(OUTBOX_KEY)).toBe(before)
    expect(fj.persisted.meta.get('migration')).not.toBe('verified')
    expect(getJournalBootNotice()?.code).toBe('verify_failed')
    expect(getOutboxStore()).toBeInstanceOf(KVOutboxStore)
  })
})

describe('crash at every step: same item set, no duplicate keys, sentinel and backup', () => {
  async function finishAfterRestart(kv: ReturnType<typeof controllableKV>['kv'], store: Map<string, string>, fj: FakeJournal, items: OutboxItem[]) {
    const j = journalOf(await boot(kv, fj.restart()))
    const loaded = (j.load() as { items: OutboxItem[] }).items
    expect(keysOf(loaded)).toEqual(keysOf([...items].sort((a, b) => a.seq - b.seq)))
    expect(new Set(keysOf(loaded)).size).toBe(items.length)
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: items.length })
    expect(legacyKeys(store).length).toBeGreaterThanOrEqual(1)
    expect(fj.persisted.rows.size).toBe(items.length)
    return j
  }

  it('copy rolls back: falls back, K untouched, next launch completes', async () => {
    const items = variety()
    const { kv, store } = seedKV(items)
    const before = store.get(OUTBOX_KEY)
    const fj = createFakeJournal()
    fj.ctl.failAt = { nthApply: 1, at: 'beforeCommit' }
    expect((await boot(kv, fj)).kind).toBe('fallback')
    expect(store.get(OUTBOX_KEY)).toBe(before)
    expect(fj.persisted.rows.size).toBe(0)
    await finishAfterRestart(kv, store, fj, items)
  })
  it('copy commits but the call fails (ambiguous): treated as committed, no duplicates', async () => {
    const items = variety()
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    fj.ctl.failAt = { nthApply: 1, at: 'afterCommit' }
    const j = journalOf(await boot(kv, fj))
    expect(j.load()).toMatchObject({ kind: 'ok' })
    expect(fj.persisted.rows.size).toBe(items.length)
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).not.toBeNull()
  })
  it('crash after copy, before the verified marker: next launch redoes the copy', async () => {
    const items = variety()
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    fj.ctl.failAt = { nthApply: 2, at: 'beforeCommit' } // the 'verified' marker
    expect((await boot(kv, fj)).kind).toBe('fallback')
    expect(fj.persisted.meta.get('migration')).toBe('copied')
    expect(fj.persisted.rows.size).toBe(items.length)
    await finishAfterRestart(kv, store, fj, items)
  })
  it('crash after the legacy backup, before the sentinel: boot error, next launch only seals', async () => {
    const items = variety()
    const { kv, store, ctl } = seedKV(items)
    const raw = store.get(OUTBOX_KEY)
    const fj = createFakeJournal()
    ctl.modeFor = (k) => (k === OUTBOX_KEY ? 'reject' : undefined)
    await expect(boot(kv, fj)).rejects.toThrow()
    expect(store.get(OUTBOX_KEY)).toBe(raw) // K still the source
    expect(legacyKeys(store)).toHaveLength(1)
    expect(fj.persisted.meta.get('migration')).toBe('verified')
    ctl.modeFor = undefined
    const next = fj.restart()
    await finishAfterRestart(kv, store, next, items)
    expect(next.ctl.applies.filter((a) => a.replaceAll)).toHaveLength(0) // sealed without re-copying
  })
  it('legacy backup write fails: boot error, nothing sealed, retry completes', async () => {
    const items = variety()
    const { kv, store, ctl } = seedKV(items)
    const fj = createFakeJournal()
    ctl.modeFor = (k) => (k.startsWith(LEGACY_BACKUP_PREFIX) ? 'reject' : undefined)
    await expect(boot(kv, fj)).rejects.toThrow()
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toBeNull()
    ctl.modeFor = undefined
    await finishAfterRestart(kv, store, fj, items)
  })
  it('crash after the sentinel: next launch is a normal boot (no migration writes)', async () => {
    const items = variety()
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    await boot(kv, fj)
    expect(fj.persisted.meta.get('migration')).toBe('sealed') // takeover is recorded in the journal itself
    adoptOutboxStore(null)
    resetJournalBootForTests()
    const next = fj.restart()
    const j = journalOf(await boot(kv, next))
    expect(next.ctl.applies).toHaveLength(0)
    expect(keysOf((j.load() as { items: OutboxItem[] }).items)).toEqual(keysOf(items))
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: items.length })
  })
  it('a verified marker with K unchanged but a lost journal row re-adds that row (never a destructive re-copy)', async () => {
    const items = variety()
    const { kv, store, ctl } = seedKV(items)
    const fj = createFakeJournal()
    ctl.modeFor = (k) => (k === OUTBOX_KEY ? 'reject' : undefined)
    await expect(boot(kv, fj)).rejects.toThrow()
    ctl.modeFor = undefined
    fj.persisted.rows.delete('d:o3') // journal lost a row after verification
    const next = fj.restart()
    const j = journalOf(await boot(kv, next))
    expect(next.ctl.applies.filter((a) => a.replaceAll)).toHaveLength(0)
    const out = (j.load() as { items: OutboxItem[] }).items
    expect(new Set(keysOf(out))).toEqual(new Set(keysOf(items)))
    expect(out).toHaveLength(items.length)
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: items.length })
  })
})

describe('after takeover: journal failures stop the app, never an empty queue', () => {
  async function sealed(items: OutboxItem[] = variety()) {
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    return { kv, store, fj }
  }
  it('open() failing is a boot error', async () => {
    const { kv, fj } = await sealed()
    const next = fj.restart()
    next.ctl.openError = new Error('disk I/O error')
    await expect(boot(kv, next)).rejects.toThrow(/Journal antrean tidak dapat dibuka/)
  })
  it('quick_check failing is a boot error', async () => {
    const { kv, fj } = await sealed()
    const next = fj.restart()
    next.ctl.open = { ...next.ctl.open, quickCheck: 'corrupt' }
    await expect(boot(kv, next)).rejects.toThrow(/Journal antrean tidak dapat dibuka/)
  })
  it('a missing journal (marker gone) is a boot error', async () => {
    const { kv } = await sealed()
    await expect(boot(kv, createFakeJournal())).rejects.toThrow(/journal hilang/)
  })
  it('a corrupt row refuses the journal with a support message', async () => {
    const { kv, fj } = await sealed()
    fj.persisted.rows.set('d:o1', { seq: 1, json: '{not json' })
    await expect(boot(kv, fj.restart())).rejects.toThrow(/rusak.*hubungi/i)
  })
  it('a malformed sentinel version is a boot error', async () => {
    const { kv, store, fj } = await sealed()
    store.set(OUTBOX_KEY, JSON.stringify({ movedTo: 'journal', v: 99, at: 'x', count: 0, sha256: 'x' }))
    await expect(boot(kv, fj.restart())).rejects.toThrow(/versi aplikasi tidak cocok/)
  })
})

describe('explicit repair of corrupt rows (never automatic)', () => {
  it('moves each bad row raw into meta quarantine.<key> in ONE apply, leaves a lasting marker, then boots', async () => {
    const items = variety()
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    const bad = fj.restart()
    bad.persisted.rows.set('d:o1', { seq: 1, json: '{not json' })
    bad.persisted.rows.set('d:o4', { seq: 4, json: JSON.stringify({ idempotencyKey: 'someone-else', seq: 4 }) })
    await expect(boot(kv, bad)).rejects.toThrow()

    const fix = bad.restart()
    const r = await quarantineCorruptRows({ kv, plugin: fix.plugin, now: () => NOW })
    expect(r.quarantined.sort()).toEqual(['d:o1', 'd:o4'])
    expect(fix.ctl.applies).toHaveLength(1)
    expect(fix.persisted.rows.has('d:o1')).toBe(false)
    expect(JSON.parse(fix.persisted.meta.get('quarantine.d:o1') as string)).toMatchObject({ key: 'd:o1', seq: 1, json: '{not json' })
    expect(store.get(OUTBOX_CORRUPTION_MARKER_KEY)).toContain('quarantine.d:o1')

    const j = journalOf(await boot(kv, fix.restart()))
    expect(keysOf((j.load() as { items: OutboxItem[] }).items)).toEqual(keysOf(items.filter((i) => !['d:o1', 'd:o4'].includes(i.idempotencyKey))))
    // the lasting banner: a new Outbox over the journal reports the marker from Preferences
    expect(new Outbox(j).corruptionInfo()).not.toBeNull()
  })
  it('does nothing and reports nothing when no row is bad', async () => {
    const { kv } = seedKV(variety())
    const fj = createFakeJournal()
    await boot(kv, fj)
    const r = await quarantineCorruptRows({ kv, plugin: fj.restart().plugin, now: () => NOW })
    expect(r.quarantined).toEqual([])
  })
})

describe('an old OTA bundle wrote the queue after the seal (merge)', () => {
  it('adds the missing keys after the journal max seq, keeps journal rows for present keys, re-seals', async () => {
    const items = [sale(1), sale(2), sale(3)]
    const { kv, store } = seedKV(items)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()

    // journal moved on (ack of o2) and the old bundle, which saw the sentinel as corrupt and started
    // from empty, queued two new sales and re-wrote the array (seq restarts at 1 and collides).
    const acked = { ...sale(2), status: 'acked' as const }
    fj.persisted.rows.set('d:o2', { seq: 2, json: JSON.stringify(acked) })
    const staleO3 = { ...sale(3), status: 'failed' as const, attempts: 2 }
    const a = sale(1, { idempotencyKey: 'd:new1', payload: { orderId: 'n1' } })
    const b = sale(2, { idempotencyKey: 'd:new2', payload: { orderId: 'n2' } })
    const oldWrite = JSON.stringify([a, staleO3, b])
    store.set(OUTBOX_KEY, oldWrite)

    const j = journalOf(await boot(kv, fj.restart()))
    const out = (j.load() as { items: OutboxItem[] }).items
    expect(keysOf(out)).toEqual(['d:o1', 'd:o2', 'd:o3', 'd:new1', 'd:new2'])
    expect(out.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5])
    expect(out[1].status).toBe('acked') // journal row kept
    expect(out[2].status).toBe('pending') // journal row kept over the differing old-bundle copy
    expect(out[3].payload).toEqual({ orderId: 'n1' })
    expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: 5, sha256: await shaOf(out) })
    expect(legacyKeys(store).some((k) => store.get(k) === oldWrite)).toBe(true)
    expect(new Set(keysOf(out)).size).toBe(5)
  })
  it('is idempotent when interrupted before the re-seal', async () => {
    const { kv, store, ctl } = seedKV([sale(1)])
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    const extra = sale(2, { idempotencyKey: 'd:late' })
    store.set(OUTBOX_KEY, JSON.stringify([sale(1), extra]))
    ctl.modeFor = (k) => (k === OUTBOX_KEY ? 'reject' : undefined)
    await expect(boot(kv, fj.restart())).rejects.toThrow()
    ctl.modeFor = undefined
    const j = journalOf(await boot(kv, fj.restart()))
    expect(keysOf((j.load() as { items: OutboxItem[] }).items)).toEqual(['d:o1', 'd:late'])
    expect(fj.persisted.rows.size).toBe(2)
  })
  it('unions synced-refund memory written by the old bundle', async () => {
    const { kv, store } = seedKV([sale(1)], { [REFUNDS_KEY]: JSON.stringify([{ orderId: 'a', at: Date.now() }]) })
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    store.set(REFUNDS_KEY, JSON.stringify([{ orderId: 'b', at: Date.now() }]))
    store.set(OUTBOX_KEY, JSON.stringify([sale(1), sale(2, { idempotencyKey: 'd:late' })]))
    const j = journalOf(await boot(kv, fj.restart()))
    const ids = (JSON.parse(j.kv.get(REFUNDS_KEY) as string) as { orderId: string }[]).map((e) => e.orderId).sort()
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('receipt archive on takeover (A41)', () => {
  const rec = (n: number) => ({ orderUuid: `u${n}`, orderNumber: `N${n}`, capturedAt: '2026-10-11T00:00:00.000Z' })

  it('copies the archive written while on the KV store into the journal and serves it', async () => {
    const archive = JSON.stringify([rec(1)])
    const { kv } = seedKV([sale(1)], { [ARCHIVE_KEY]: archive })
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    expect(fj.persisted.meta.get(ARCHIVE_KEY)).toBe(archive)
    expect(j.kv.get(ARCHIVE_KEY)).toBe(archive)
  })

  it('writes no archive meta when there was none', async () => {
    const { kv } = seedKV([sale(1)])
    const fj = createFakeJournal()
    await boot(kv, fj)
    expect(fj.persisted.meta.has(ARCHIVE_KEY)).toBe(false)
  })

  it('unions an archive that reached the KV after the seal, journal entry winning', async () => {
    const { kv, store } = seedKV([sale(1)], { [ARCHIVE_KEY]: JSON.stringify([rec(1)]) })
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    store.set(ARCHIVE_KEY, JSON.stringify([{ ...rec(1), orderNumber: 'STALE' }, rec(2)]))
    store.set(OUTBOX_KEY, JSON.stringify([sale(1), sale(2, { idempotencyKey: 'd:late' })]))
    const j = journalOf(await boot(kv, fj.restart()))
    const list = JSON.parse(j.kv.get(ARCHIVE_KEY) as string) as { orderUuid: string; orderNumber: string }[]
    expect(list.map((e) => e.orderUuid).sort()).toEqual(['u1', 'u2'])
    expect(list.find((e) => e.orderUuid === 'u1')?.orderNumber).toBe('N1')
  })
})

describe('corruption marker left by an old bundle that met the sentinel', () => {
  it('is ignored by the new Outbox (the quarantined bytes are our sentinel)', async () => {
    const { kv, store } = seedKV([sale(1)])
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    const sentinel = store.get(OUTBOX_KEY) as string
    store.set(OUTBOX_QUARANTINE_PREFIX + 't', sentinel)
    store.set(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify({ quarantineKey: OUTBOX_QUARANTINE_PREFIX + 't', detectedAt: 't' }))
    expect(new Outbox(j).corruptionInfo()).toBeNull()
  })
  it('still raises a real marker', async () => {
    const { kv, store } = seedKV([sale(1)])
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    store.set(OUTBOX_QUARANTINE_PREFIX + 't', '{real damage')
    store.set(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify({ quarantineKey: OUTBOX_QUARANTINE_PREFIX + 't', detectedAt: 't' }))
    expect(new Outbox(j).corruptionInfo()).not.toBeNull()
  })
  it('the Outbox reads and writes its notice keys through Preferences, not the journal meta', async () => {
    const { kv, store } = seedKV([sale(1)])
    const fj = createFakeJournal()
    const j = journalOf(await boot(kv, fj))
    expect(j).toBeInstanceOf(JournalOutboxStore)
    expect(j.noticeKV).toBe(kv)
    new Outbox(j)
    expect(store.get(OUTBOX_CORRUPTION_MARKER_KEY)).toBeUndefined()
  })
})

// Opus review of phase B: once the journal is taken over (meta verified/sealed) Preferences can never
// overwrite it, and no failure falls back to the old storage.
const jitem = (k: string, seq: number): OutboxItem => sale(seq, { idempotencyKey: k, payload: { orderId: k } })

describe('takeover is one-way: no destructive re-copy (CRITICAL-1)', () => {
  for (const kval of ['[]', null, 'garbage{'] as const) {
    it(`sealed empty migration, journal moved on, K later = ${kval}: rows and refund memory are kept`, async () => {
      const { kv, store } = seedKV(null)
      const fj = createFakeJournal()
      expect((await boot(kv, fj)).kind).toBe('journal')
      adoptOutboxStore(null)
      resetJournalBootForTests()
      for (const [k, seq] of [['d:a', 1], ['d:b', 2]] as const) fj.persisted.rows.set(k, { seq, json: JSON.stringify(jitem(k, seq)) })
      const refunds = JSON.stringify([{ orderId: 'r1', at: Date.now() }])
      fj.persisted.meta.set(REFUNDS_KEY, refunds) // recorded on the journal after takeover
      if (kval === null) store.delete(OUTBOX_KEY)
      else store.set(OUTBOX_KEY, kval)
      const next = fj.restart()
      const r = await boot(kv, next)
      expect(r.kind).toBe('journal')
      expect(next.ctl.applies.filter((a) => a.replaceAll)).toHaveLength(0)
      expect(fj.persisted.rows.size).toBe(2)
      expect(JSON.parse(fj.persisted.meta.get(REFUNDS_KEY) as string).map((e: { orderId: string }) => e.orderId)).toContain('r1')
      expect(parseSentinel(store.get(OUTBOX_KEY) ?? null)).toMatchObject({ count: 2 })
    })
  }
  it('a stale Preferences queue after a power-loss revert cannot remove journal rows', async () => {
    const { kv, store } = seedKV([sale(1)])
    const raw = store.get(OUTBOX_KEY) as string
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    fj.persisted.rows.set('d:o9', { seq: 9, json: JSON.stringify(sale(9)) })
    store.set(OUTBOX_KEY, raw) // the un-fsynced Preferences write of the sentinel was lost
    const j = journalOf(await boot(kv, fj.restart()))
    expect(keysOf((j.load() as { items: OutboxItem[] }).items)).toEqual(['d:o1', 'd:o9'])
  })
  it('a malformed K in the verified state is kept raw in a backup and the journal still boots', async () => {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    fj.persisted.rows.set('d:a', { seq: 1, json: JSON.stringify(jitem('d:a', 1)) })
    const bad = JSON.stringify([jitem('n', 1), jitem('n', 1)])
    store.set(OUTBOX_KEY, bad)
    const j = journalOf(await boot(kv, fj.restart()))
    expect(keysOf((j.load() as { items: OutboxItem[] }).items)).toEqual(['d:a'])
    expect(legacyKeys(store).some((k) => store.get(k) === bad)).toBe(true)
    expect(getJournalBootNotice()).toBeNull()
  })
})

describe('after takeover no failure falls back to the old storage (MEDIUM-1)', () => {
  async function takenOver() {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    fj.persisted.rows.set('d:a', { seq: 1, json: JSON.stringify(jitem('d:a', 1)) })
    store.set(OUTBOX_KEY, JSON.stringify([jitem('n', 1)])) // old bundle wrote an array
    return { kv, store, fj }
  }
  it('open() failing with a legacy backup in Preferences is a boot error', async () => {
    const { kv, store, fj } = await takenOver()
    store.set(LEGACY_BACKUP_PREFIX + 'x', '[]')
    const next = fj.restart()
    next.ctl.openError = new Error('io')
    await expect(boot(kv, next)).rejects.toThrow(/Journal antrean tidak dapat dibuka/)
  })
  it('open() failing with a corruption marker that points at our sentinel is a boot error', async () => {
    const { kv, store, fj } = await takenOver()
    const sentinel = JSON.stringify({ movedTo: 'journal', v: 1, at: 'x', count: 0, sha256: 'x' })
    store.set(OUTBOX_QUARANTINE_PREFIX + 't', sentinel)
    store.set(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify({ quarantineKey: OUTBOX_QUARANTINE_PREFIX + 't', detectedAt: 't' }))
    const next = fj.restart()
    next.ctl.openError = new Error('io')
    await expect(boot(kv, next)).rejects.toThrow(/Journal antrean tidak dapat dibuka/)
  })
  it('a merge that cannot be written is a boot error, not a fallback', async () => {
    const { kv, fj } = await takenOver()
    const next = fj.restart()
    next.ctl.failAt = { nthApply: 1, at: 'beforeCommit' }
    await expect(boot(kv, next)).rejects.toThrow()
    expect(getJournalBootNotice()).toBeNull()
  })
  it('without any takeover evidence an open() failure still falls back (Q1)', async () => {
    const { kv } = seedKV([sale(1)])
    const fj = createFakeJournal()
    fj.ctl.openError = new Error('io')
    expect((await boot(kv, fj)).kind).toBe('fallback')
  })
})

describe('Preferences always records the takeover (R1/R2)', () => {
  it('an empty-source seal (no backup) still writes the durable takeover key', async () => {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    await boot(kv, fj)
    expect(legacyKeys(store)).toHaveLength(0)
    expect(store.get(TAKEOVER_KEY)).toBe(NOW.toISOString())
  })
  it('R1: empty-source seal, sentinel lost, journal open() failing on the same boot -> boot error, not a fallback', async () => {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    store.delete(OUTBOX_KEY) // un-fsynced Preferences write lost
    const next = fj.restart()
    next.ctl.openError = new Error('io')
    await expect(boot(kv, next)).rejects.toThrow(/Journal antrean tidak dapat dibuka/)
    expect(getJournalBootNotice()).toBeNull()
  })
  it('R2: journal opens without a takeover marker while Preferences shows takeover and K is not a sentinel -> journal hilang, no fresh copy', async () => {
    const { kv, store } = seedKV(null)
    const fj = createFakeJournal()
    await boot(kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    store.set(OUTBOX_KEY, JSON.stringify([sale(1)]))
    const wiped = createFakeJournal() // journal file replaced/recreated: no meta
    await expect(boot(kv, wiped)).rejects.toThrow(/journal hilang/)
    expect(wiped.ctl.applies).toHaveLength(0)
    expect(wiped.persisted.rows.size).toBe(0)
  })
})
