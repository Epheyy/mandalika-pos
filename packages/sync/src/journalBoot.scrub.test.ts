import { afterEach, describe, expect, it, vi } from 'vitest'
import { initJournal, LEGACY_BACKUP_PREFIX, resetJournalBootForTests } from './journalBoot'
import { adoptOutboxStore } from './storage'
import { OUTBOX_KEY, OUTBOX_QUARANTINE_PREFIX } from './outbox'
import { scrubPinFromRawQueue } from './scrubStoredCopies'
import { controllableKV } from './testFixtures/controllableKV'
import { createFakeJournal } from './testFixtures/fakeJournal'

const NOW = new Date('2026-10-20T03:00:00.000Z')
const env = { userId: 'u1', deviceId: 'dev', outletId: 'o1', capturedAt: '2026-10-11T00:00:00.000Z' }
const item = (seq: number, over: Record<string, unknown> = {}) => ({
  idempotencyKey: `dev:${seq}`, type: 'transfer_receive', payload: { transferId: `t${seq}`, pin: '1234', approverUserId: 'a' },
  seq, status: 'pending', clientCreatedAt: '2026-10-11T00:00:00.000Z', envelope: env, ...over,
})
const queue = () => [item(1), item(2, { status: 'acked' }), item(3, { type: 'order', payload: { total: 1, pin: 'keep-me' } })]

afterEach(() => { adoptOutboxStore(null); resetJournalBootForTests(); vi.restoreAllMocks() })

const boot = (kv: ReturnType<typeof controllableKV>['kv'], fj = createFakeJournal()) =>
  initJournal({ kv, plugin: fj.plugin, isPluginAvailable: () => true, now: () => NOW })

// A08: a raw approver PIN may sit in the stored copies the journal takeover keeps for safety.
// They are scrubbed in place (parseable ones) and never deleted.
describe('scrubPinFromRawQueue', () => {
  it('strips pin from transfer_receive items only, preserving everything else', () => {
    const out = JSON.parse(scrubPinFromRawQueue(JSON.stringify(queue()))!)
    expect(out[0].payload).toEqual({ transferId: 't1', approverUserId: 'a' })
    expect(out[1].status).toBe('acked')
    expect(out[2].payload).toEqual({ total: 1, pin: 'keep-me' })
    expect(out.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3])
  })
  it('returns null when nothing changes or the text is not an item list', () => {
    expect(scrubPinFromRawQueue(JSON.stringify([item(1, { payload: { transferId: 't' } })]))).toBeNull()
    expect(scrubPinFromRawQueue('not json {')).toBeNull()
    expect(scrubPinFromRawQueue('{"a":1}')).toBeNull()
  })
})

describe('initJournal scrubs the stored copies', () => {
  it('the legacy backup written at takeover carries no PIN, and is kept', async () => {
    const { kv, store } = controllableKV({ [OUTBOX_KEY]: JSON.stringify(queue()) })
    await boot(kv)
    const backups = [...store.keys()].filter((k) => k.startsWith(LEGACY_BACKUP_PREFIX))
    expect(backups).toHaveLength(1)
    const copy = JSON.parse(store.get(backups[0])!)
    expect(copy).toHaveLength(3)
    expect(copy[0].payload).not.toHaveProperty('pin')
    expect(copy[2].payload).toHaveProperty('pin') // not a transfer_receive
  })

  // A tablet already taken over by the journal, rebooted after the copies appeared.
  const rebootTakenOver = async (extra: Record<string, string>, meta: Record<string, string> = {}, rejectKey?: string) => {
    const fj = createFakeJournal()
    const c = controllableKV({ [OUTBOX_KEY]: '[]' })
    await boot(c.kv, fj)
    adoptOutboxStore(null)
    resetJournalBootForTests()
    for (const [k, v] of Object.entries(extra)) c.store.set(k, v)
    for (const [k, v] of Object.entries(meta)) fj.persisted.meta.set(k, v)
    if (rejectKey) c.ctl.modeFor = (k) => (k === rejectKey ? 'reject' : undefined)
    const fj2 = fj.restart()
    const result = await boot(c.kv, fj2)
    return { ...c, fj, result }
  }

  it('scrubs an older legacy backup and a parseable corrupt copy, and leaves an unparseable one untouched', async () => {
    const bad = '[{"type":"transfer_receive","payload":{"pin":"1234"'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { store } = await rebootTakenOver({
      [LEGACY_BACKUP_PREFIX + 'old']: JSON.stringify(queue()),
      [OUTBOX_QUARANTINE_PREFIX + 'ok']: JSON.stringify(queue()),
      [OUTBOX_QUARANTINE_PREFIX + 'bad']: bad,
    })
    expect(store.get(LEGACY_BACKUP_PREFIX + 'old')).not.toContain('"1234"')
    expect(store.get(OUTBOX_QUARANTINE_PREFIX + 'ok')).not.toContain('"1234"')
    expect(JSON.parse(store.get(OUTBOX_QUARANTINE_PREFIX + 'ok')!)).toHaveLength(3)
    expect(store.get(OUTBOX_QUARANTINE_PREFIX + 'bad')).toBe(bad)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unparseable'), expect.arrayContaining([OUTBOX_QUARANTINE_PREFIX + 'bad']))
  })

  it('scrubs a journal quarantine row in meta and keeps the key and the other fields', async () => {
    const row = { key: 'dev:9', seq: 9, json: JSON.stringify(item(9)), at: NOW.toISOString() }
    const { fj } = await rebootTakenOver({}, { 'quarantine.dev:9': JSON.stringify(row), 'quarantine.garbage': 'not json' })
    const stored = JSON.parse(fj.persisted.meta.get('quarantine.dev:9')!)
    expect(stored).toMatchObject({ key: 'dev:9', seq: 9, at: NOW.toISOString() })
    expect(JSON.parse(stored.json).payload).toEqual({ transferId: 't9', approverUserId: 'a' })
    expect(fj.persisted.meta.get('quarantine.garbage')).toBe('not json')
  })

  it('reports a failed rewrite as a write failure, not as unparseable, and leaves the copy as it was', async () => {
    const key = LEGACY_BACKUP_PREFIX + 'stuck'
    const raw = JSON.stringify(queue())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { store } = await rebootTakenOver({ [key]: raw }, {}, key)
    expect(store.get(key)).toBe(raw)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be rewritten'), [key])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('unparseable'))).toBe(false)
  })

  it('writes nothing when no copy holds a PIN', async () => {
    const clean = JSON.stringify([item(1, { payload: { transferId: 't', approvalGrantId: 'g' } })])
    const { ctl } = await rebootTakenOver({ [LEGACY_BACKUP_PREFIX + 'x']: clean })
    expect(ctl.attempts.filter((a) => a.key === LEGACY_BACKUP_PREFIX + 'x')).toHaveLength(0)
  })
})
