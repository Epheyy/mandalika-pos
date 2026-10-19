// A01b Phase A: the Outbox must behave identically over the KV store (today's behaviour) and the
// SQLite journal store. The first describe.each re-runs the durable-add scenarios of
// outbox.durable.test.ts against both stores; the rest pins the journal-specific guarantees
// (one atomic apply per commit, prev-diffing, byte-exact item JSON, refusal to adopt an unsafe DB).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Outbox, type OutboxItem } from './outbox'
import { KVOutboxStore } from './outboxStore'
import { SyncedRefunds } from './syncedRefunds'
import { JournalOutboxStore, JournalUnavailableError } from './journalOutboxStore'
import { controllableKV } from './testFixtures/controllableKV'
import { createFakeJournal, persistedItems, type FakeJournal } from './testFixtures/fakeJournal'

const OUTBOX_KEY = 'mandalika.pos.outbox'
const SYNCED_REFUNDS_KEY = 'mandalika.pos.syncedRefunds'
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

interface Backend {
  name: string
  newOutbox(): Outbox
  ctl: { mode: 'ok' | 'reject' | 'hold'; held: { resolve(): void }[]; writes(): number }
  stored(): OutboxItem[]
}

async function kvBackend(): Promise<Backend> {
  const { kv, store, ctl } = controllableKV()
  return {
    name: 'kv',
    newOutbox: () => new Outbox(new KVOutboxStore(kv)),
    ctl: {
      get mode() { return ctl.mode },
      set mode(m) { ctl.mode = m },
      held: ctl.held,
      writes: () => ctl.attempts.filter((a) => a.key === OUTBOX_KEY).length,
    },
    stored: () => JSON.parse(store.get(OUTBOX_KEY) ?? '[]'),
  }
}

async function journalBackend(): Promise<Backend> {
  const fake = createFakeJournal()
  const store = await JournalOutboxStore.open(fake.plugin)
  return {
    name: 'journal',
    newOutbox: () => new Outbox(store),
    ctl: {
      get mode() { return fake.ctl.mode },
      set mode(m) { fake.ctl.mode = m },
      held: fake.ctl.held,
      writes: () => fake.ctl.applies.length,
    },
    stored: () => persistedItems(fake.persisted) as OutboxItem[],
  }
}

describe.each([
  ['kv', kvBackend],
  ['journal', journalBackend],
] as const)('Outbox durable add over the %s store', (_name, create) => {
  it('rejects a failed write and leaves no trace in memory or storage', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    b.ctl.mode = 'reject'
    await expect(outbox.add('order', 'dev:1', { total: 1 })).rejects.toThrow()
    expect(outbox.all()).toEqual([])
    expect(outbox.pending()).toEqual([])
    expect(outbox.count()).toBe(0)
    expect(b.stored()).toEqual([])
    // The failed attempt must not burn a sequence number or poison the queue.
    b.ctl.mode = 'ok'
    const item = await outbox.add('order', 'dev:2', { total: 2 })
    expect(item.seq).toBe(1)
    expect(b.stored().map((i) => i.idempotencyKey)).toEqual(['dev:2'])
  })

  it('returns the existing item for a duplicate key without a second write', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    const first = await outbox.add('order', 'dev:1', { a: 1 })
    const again = await outbox.add('order', 'dev:1', { a: 2 })
    expect(again).toBe(first)
    expect(b.ctl.writes()).toBe(1)
  })

  it('does not expose an item to pending() until its write has committed', async () => {
    const b = await create()
    b.ctl.mode = 'hold'
    const outbox = b.newOutbox()
    const added = outbox.add('order', 'dev:1', {})
    await tick()
    expect(b.ctl.held).toHaveLength(1)
    expect(outbox.pending()).toEqual([])
    expect(outbox.all()).toEqual([])
    b.ctl.held[0].resolve()
    await added
    expect(outbox.pending().map((i) => i.idempotencyKey)).toEqual(['dev:1'])
  })

  it('serializes concurrent adds and an ack so stored == memory and order is preserved', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    await outbox.add('order', 'dev:A', {})
    b.ctl.mode = 'hold'
    const second = outbox.add('order', 'dev:B', {})
    const third = outbox.add('order', 'dev:C', {})
    const ackA = outbox.ack('dev:A')
    await tick()
    // Only one write may be in flight: later ones wait their turn.
    expect(b.ctl.held).toHaveLength(1)
    b.ctl.held.shift()!.resolve()
    await second
    await tick()
    expect(b.ctl.held).toHaveLength(1)
    b.ctl.held.shift()!.resolve()
    await third
    await tick()
    b.ctl.held.shift()!.resolve()
    await ackA
    const memory = outbox.all()
    expect(b.stored()).toEqual(memory)
    expect(memory.map((i) => [i.idempotencyKey, i.status, i.seq])).toEqual([
      ['dev:A', 'acked', 1], ['dev:B', 'pending', 2], ['dev:C', 'pending', 3],
    ])
  })

  it('keeps memory unchanged and keeps going when a best-effort ack write fails', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    await outbox.add('order', 'dev:A', {})
    const before = JSON.stringify(b.stored())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    b.ctl.mode = 'reject'
    await outbox.ack('dev:A') // resolves; failure is logged, not thrown
    expect(outbox.all()[0].status).toBe('pending') // memory never ahead of disk
    expect(JSON.stringify(b.stored())).toBe(before)
    b.ctl.mode = 'ok'
    await outbox.ack('dev:A')
    expect(outbox.all()[0].status).toBe('acked')
  })

  it('rejects a failed manual retry reset and leaves items parked', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    await outbox.add('order', 'dev:A', {})
    for (let i = 0; i < 5; i++) await outbox.fail('dev:A', 'denied')
    expect(outbox.deadLettered()).toHaveLength(1)
    b.ctl.mode = 'reject'
    await expect(outbox.retryDeadLettered()).rejects.toThrow()
    expect(outbox.deadLettered()).toHaveLength(1)
  })

  it('settles a whole batch of results with one write (settle + prune = 2)', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    for (let i = 0; i < 5; i++) await outbox.add('order', `dev:${i}`, {})
    const before = b.ctl.writes()
    await outbox.settle([0, 1, 2, 3, 4].map((i) => ({ key: `dev:${i}`, op: 'ack' as const })))
    await outbox.prune()
    expect(b.ctl.writes() - before).toBe(2)
    expect(outbox.all()).toEqual([])
    expect(b.stored()).toEqual([])
  })
})

describe('KVOutboxStore', () => {
  it('reports an empty or absent key as ok/empty and non-array JSON as corrupt with the raw bytes', () => {
    expect(new KVOutboxStore(controllableKV().kv).load()).toEqual({ kind: 'ok', items: [] })
    expect(new KVOutboxStore(controllableKV({ [OUTBOX_KEY]: '[]' }).kv).load()).toEqual({ kind: 'ok', items: [] })
    for (const raw of ['{}', 'null', '"x"', '7', '[{"idempotencyKey":"dev:1"']) {
      expect(new KVOutboxStore(controllableKV({ [OUTBOX_KEY]: raw }).kv).load()).toEqual({ kind: 'corrupt', raw })
    }
  })

  it('writes the whole array with setDurable and exposes its kv', async () => {
    const { kv, store } = controllableKV()
    const s = new KVOutboxStore(kv)
    expect(s.kv).toBe(kv)
    const item = { idempotencyKey: 'dev:1', type: 'order', payload: {}, seq: 1, status: 'pending', clientCreatedAt: 't' } as OutboxItem
    await s.commit([], [item])
    expect(store.get(OUTBOX_KEY)).toBe(JSON.stringify([item]))
  })

  it('an Outbox still accepts a bare KV (existing call sites)', async () => {
    const { kv, store } = controllableKV()
    const outbox = new Outbox(kv)
    await outbox.add('order', 'dev:1', {})
    expect(JSON.parse(store.get(OUTBOX_KEY)!)).toHaveLength(1)
  })
})

describe('JournalOutboxStore commits', () => {
  const setup = async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    return { fake, store, outbox: new Outbox(store) }
  }

  it('settle of 100 items is exactly one apply with 100 upserts', async () => {
    const { fake, outbox } = await setup()
    for (let i = 0; i < 100; i++) await outbox.add('order', `dev:${i}`, { total: i })
    const before = fake.ctl.applies.length
    await outbox.settle(Array.from({ length: 100 }, (_, i) => ({ key: `dev:${i}`, op: 'ack' as const })))
    expect(fake.ctl.applies.length - before).toBe(1)
    const last = fake.ctl.applies[fake.ctl.applies.length - 1]
    expect(last.upserts).toHaveLength(100)
    expect(last.deletes).toEqual([])
    expect(last.replaceAll).toBeFalsy()
  })

  it('an add upserts only the new row (O(1) bytes, not the whole queue)', async () => {
    const { fake, outbox } = await setup()
    for (let i = 0; i < 3; i++) await outbox.add('order', `dev:${i}`, {})
    const last = fake.ctl.applies[fake.ctl.applies.length - 1]
    expect(last.upserts.map((u) => u.key)).toEqual(['dev:2'])
    expect(last.deletes).toEqual([])
  })

  it('prune is deletes only', async () => {
    const { fake, outbox } = await setup()
    await outbox.add('order', 'dev:A', {})
    await outbox.add('order', 'dev:B', {})
    await outbox.ack('dev:A')
    await outbox.prune()
    const last = fake.ctl.applies[fake.ctl.applies.length - 1]
    expect(last.upserts).toEqual([])
    expect(last.deletes).toEqual(['dev:A'])
    expect([...fake.persisted.rows.keys()]).toEqual(['dev:B'])
  })

  it('does no apply when nothing changed', async () => {
    const { fake, store } = await setup()
    await store.commit([], [])
    expect(fake.ctl.applies).toHaveLength(0)
  })

  it('a stale instance cannot delete rows it never saw', async () => {
    const { fake, store } = await setup()
    const seed = new Outbox(store)
    await seed.add('order', 'dev:Z', {})
    const stale = new Outbox(store)
    const live = new Outbox(store)
    await live.add('order', 'dev:X', {})
    // stale never saw dev:X; discarding its own dev:Z must delete exactly that and nothing else.
    await stale.discard('dev:Z')
    expect([...fake.persisted.rows.keys()]).toEqual(['dev:X'])
    await stale.prune()
    expect([...fake.persisted.rows.keys()]).toEqual(['dev:X'])
  })

  it('a stale instance does not rewrite an item it merely carried along', async () => {
    const { fake, store } = await setup()
    const seed = new Outbox(store)
    await seed.add('order', 'dev:Z', {})
    const stale = new Outbox(store) // still sees dev:Z as pending
    const live = new Outbox(store)
    await live.ack('dev:Z') // persisted + mirror: acked
    await stale.add('order', 'dev:W', {})
    const rows = persistedItems(fake.persisted) as OutboxItem[]
    expect(rows.map((i) => [i.idempotencyKey, i.status])).toEqual([['dev:Z', 'acked'], ['dev:W', 'pending']])
    expect(fake.ctl.applies[fake.ctl.applies.length - 1].upserts.map((u) => u.key)).toEqual(['dev:W'])
  })

  it('a failed apply (crash before commit) leaves mirror and rows unchanged', async () => {
    const { fake, store, outbox } = await setup()
    await outbox.add('order', 'dev:A', {})
    const rowsBefore = JSON.stringify([...fake.persisted.rows])
    fake.ctl.failAt = 'beforeCommit'
    await expect(outbox.add('order', 'dev:B', {})).rejects.toThrow('crash before commit')
    expect(JSON.stringify([...fake.persisted.rows])).toBe(rowsBefore)
    expect(outbox.all().map((i) => i.idempotencyKey)).toEqual(['dev:A'])
    expect(new Outbox(store).all().map((i) => i.idempotencyKey)).toEqual(['dev:A']) // mirror too
    const next = await outbox.add('order', 'dev:C', {})
    expect(next.seq).toBe(2) // the failed add burned no seq
  })

  it('crash after commit (H1): the add is recognised as committed and the next add gets a fresh seq', async () => {
    const { fake, store, outbox } = await setup()
    fake.ctl.failAt = 'afterCommit'
    const first = await outbox.add('order', 'dev:A', {})
    expect(first.seq).toBe(1)
    expect(outbox.all().map((i) => i.idempotencyKey)).toEqual(['dev:A'])
    const second = await outbox.add('order', 'dev:B', {})
    expect(second.seq).toBe(2)
    expect([...fake.persisted.rows.keys()]).toEqual(['dev:A', 'dev:B'])
    expect(new Outbox(store).all().map((i) => i.idempotencyKey)).toEqual(['dev:A', 'dev:B'])
  })

  it('crash after commit (H1): a delete that committed is not reported as failed either', async () => {
    const { fake, outbox } = await setup()
    await outbox.add('order', 'dev:A', {})
    await outbox.ack('dev:A')
    fake.ctl.failAt = 'afterCommit'
    await outbox.prune()
    expect(outbox.all()).toEqual([])
    expect(fake.persisted.rows.size).toBe(0)
  })

  it('a rejected apply that did not commit resyncs the mirror from disk and still rejects', async () => {
    const { fake, store, outbox } = await setup()
    await outbox.add('order', 'dev:A', {})
    // Something changed the file behind the mirror's back.
    fake.persisted.rows.set('dev:X', { seq: 9, json: JSON.stringify({ idempotencyKey: 'dev:X', seq: 9, type: 'order', payload: {}, status: 'pending', clientCreatedAt: 't' }) })
    fake.ctl.failAt = 'beforeCommit'
    await expect(outbox.add('order', 'dev:B', {})).rejects.toThrow('crash before commit')
    expect(new Outbox(store).all().map((i) => i.idempotencyKey)).toEqual(['dev:A', 'dev:X'])
  })

  it('nthApply injection fails exactly that apply', async () => {
    const { fake, outbox } = await setup()
    fake.ctl.failAt = { nthApply: 2 }
    await outbox.add('order', 'dev:A', {})
    await expect(outbox.add('order', 'dev:B', {})).rejects.toThrow()
    await outbox.add('order', 'dev:C', {})
    expect(outbox.all().map((i) => i.idempotencyKey)).toEqual(['dev:A', 'dev:C'])
  })

  it('a second live writer gets a fresh seq (store.maxSeq) instead of colliding', async () => {
    const { fake, store } = await setup()
    const a = new Outbox(store)
    const b = new Outbox(store)
    await a.add('order', 'dev:A', {})
    const added = await b.add('order', 'dev:B', {})
    expect(added.seq).toBe(2)
    expect([...fake.persisted.rows.keys()]).toEqual(['dev:A', 'dev:B'])
  })

  it('an outbox replaced while an add is in flight: the new instance does not collide', async () => {
    const { fake, store } = await setup()
    fake.ctl.mode = 'hold'
    const old = new Outbox(store)
    const inFlight = old.add('order', 'dev:A', {})
    await tick()
    old.dispose()
    const fresh = new Outbox(store)
    const second = fresh.add('order', 'dev:B', {})
    await tick()
    fake.ctl.held.shift()!.resolve()
    await tick()
    fake.ctl.held.shift()!.resolve()
    expect((await inFlight).seq).toBe(1)
    expect((await second).seq).toBe(2)
    expect([...fake.persisted.rows.values()].map((r) => r.seq).sort()).toEqual([1, 2])
    // Phase B rule: refresh the replacement once the old instance and the store are idle.
    await store.idle()
    await fresh.refresh()
    expect(fresh.all().map((i) => i.idempotencyKey)).toEqual(['dev:A', 'dev:B'])
  })

  it('HIGH-1: after a conflicting round the live outbox reloads, so the next settle lands both acks', async () => {
    const { fake, store } = await setup()
    const old = new Outbox(store)
    await old.add('order', 'dev:K', {})
    await old.add('order', 'dev:L', {})
    fake.ctl.mode = 'hold'
    const inFlight = old.ack('dev:K') // old engine's settle in flight
    await tick()
    old.dispose()
    const live = new Outbox(store) // new engine built after logout: sees K and L pending
    fake.ctl.held.shift()!.resolve()
    fake.ctl.mode = 'ok'
    await inFlight
    await tick()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const both = [{ key: 'dev:K', op: 'ack' as const }, { key: 'dev:L', op: 'ack' as const }]
    await live.settle(both) // CAS conflict on K: swallowed, but the view must resync
    await live.settle(both)
    const rows = persistedItems(fake.persisted) as OutboxItem[]
    expect(rows.map((i) => [i.idempotencyKey, i.status])).toEqual([['dev:K', 'acked'], ['dev:L', 'acked']])
    expect(live.pending()).toEqual([])
  })

  it('HIGH-1: a rejected add still rejects loudly, and the outbox view is reloaded from the store', async () => {
    const { fake, store } = await setup()
    const a = new Outbox(store)
    await a.add('customer_create', 'dev:C1', {})
    const stale = new Outbox(store)
    await a.ack('dev:C1')
    fake.ctl.failAt = 'beforeCommit'
    await expect(stale.add('order', 'dev:O', {})).rejects.toThrow('crash before commit')
    expect(stale.all().map((i) => [i.idempotencyKey, i.status])).toEqual([['dev:C1', 'acked']])
  })

  it('L1: when readAll also fails after a rejected apply, the next add still gets a fresh seq', async () => {
    const { fake, outbox } = await setup()
    fake.ctl.failAt = 'afterCommit'
    fake.ctl.readAllFails = true
    await expect(outbox.add('order', 'dev:A', {})).rejects.toThrow('crash after commit')
    fake.ctl.readAllFails = false
    const next = await outbox.add('order', 'dev:B', {})
    expect(next.seq).toBe(2) // A committed with seq 1 even though nobody could confirm it
  })

  it('L4: two live instances adding at the same moment pick different seqs', async () => {
    const { fake, store } = await setup()
    const a = new Outbox(store)
    const b = new Outbox(store)
    const [x, y] = await Promise.all([a.add('order', 'dev:A', {}), b.add('order', 'dev:B', {})])
    expect([x.seq, y.seq].sort()).toEqual([1, 2])
    expect(fake.persisted.rows.size).toBe(2)
  })

  it('M1: a stale instance cannot overwrite a row another instance changed', async () => {
    const { fake, store } = await setup()
    const seed = new Outbox(store)
    await seed.add('order', 'dev:Z', {})
    const stale = new Outbox(store)
    const live = new Outbox(store)
    await live.ack('dev:Z')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await stale.fail('dev:Z', 'denied') // best-effort: swallowed, but must not write
    expect((persistedItems(fake.persisted) as OutboxItem[])[0].status).toBe('acked')
    expect(stale.all()[0].status).toBe('acked') // view resynced to what is on disk
    expect(console.error).toHaveBeenCalled()
  })

  it('M1: compare-and-swap rejects loudly on a changed row, a duplicate insert and a resurrecting update', async () => {
    const { fake, store } = await setup()
    const item = (status: string) => ({ idempotencyKey: 'dev:Z', type: 'order', payload: {}, seq: 1, status, clientCreatedAt: 't' }) as OutboxItem
    await store.commit([], [item('pending')])
    await expect(store.commit([item('failed')], [item('acked')])).rejects.toThrow(/conflict/i) // prev != disk
    await expect(store.commit([], [item('acked')])).rejects.toThrow(/conflict/i) // insert over existing key
    await store.commit([item('pending')], []) // delete
    await expect(store.commit([item('pending')], [item('acked')])).rejects.toThrow(/conflict/i) // update of a deleted row
    expect(fake.persisted.rows.size).toBe(0)
  })

  it('restart: a new store over the same file sees every committed item in seq order', async () => {
    const { fake, outbox } = await setup()
    await outbox.add('order', 'dev:A', { total: 10.5 })
    await outbox.add('refund', 'dev:B', {})
    await outbox.ack('dev:A')
    const store2 = await JournalOutboxStore.open(fake.restart().plugin)
    const second = new Outbox(store2)
    expect(second.all()).toEqual(outbox.all())
    await expect(second.add('order', 'dev:C', {})).resolves.toMatchObject({ seq: 3 })
  })

  it('a disposed outbox refuses to write', async () => {
    const { fake, outbox } = await setup()
    outbox.dispose()
    await expect(outbox.add('order', 'dev:A', {})).rejects.toThrow('outbox disposed')
    expect(fake.ctl.applies).toHaveLength(0)
  })
})

describe('JournalOutboxStore item bytes', () => {
  const env = { userId: 'u1', deviceId: 'dev', outletId: 'o1', capturedAt: '2026-10-11T00:00:00.000Z', shiftId: 'sh1' }
  // Hand-written, deliberately non-canonical items: odd key order, unicode, float totals.
  const fixture = [
    { idempotencyKey: 'dev:sale', type: 'order', seq: 1, status: 'pending', clientCreatedAt: 't1',
      payload: { total: 10.5, tax: 0.1 + 0.2, note: 'Parfum éè ✨ マンダリカ', items: [{ productId: 'p1', qty: 2, price: 5.25, nested: { a: [1, 2, { b: null }] } }] },
      envelope: env },
    { idempotencyKey: 'dev:refund', type: 'refund', seq: 2, status: 'pending', clientCreatedAt: 't2',
      payload: { orderId: 'o1', display: { orderRef: 'POS-0001', refundTotal: 10.5, items: [{ name: 'Parfum', qty: 1 }] } },
      envelope: { ...env, shiftId: undefined } },
    { status: 'failed', seq: 3, type: 'order', idempotencyKey: 'dev:parked', clientCreatedAt: 't3', payload: { total: 1 },
      attempts: 5, reviewCode: 'competing_receipt', reviewReason: 'ditolak', lastError: 'ditolak', envelope: env },
    { idempotencyKey: 'dev:retry', type: 'cash_flow', seq: 4, status: 'failed', clientCreatedAt: 't4', payload: { amount: 100000 },
      attempts: 0, retryableFailures: 3, lastError: 'timeout', envelope: env },
    { idempotencyKey: 'dev:acked', type: 'shift_close', seq: 5, status: 'acked', clientCreatedAt: 't5', payload: { closing: 0 }, envelope: env },
    { idempotencyKey: 'dev:legacy', type: 'order', seq: 6, status: 'pending', clientCreatedAt: 't6', payload: { total: 12345678.9 } },
    { idempotencyKey: 'dev:receive', type: 'transfer_receive', seq: 7, status: 'pending', clientCreatedAt: 't7',
      payload: { transferId: 't1', approverUserId: 'u1', pin: '1234', items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }] }, envelope: env },
  ] as unknown as OutboxItem[]

  it('stores each item as exactly JSON.stringify(item) and round-trips byte-identically', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    await store.commit([], fixture)
    for (const item of fixture) {
      expect(fake.persisted.rows.get(item.idempotencyKey)!.json).toBe(JSON.stringify(item))
    }
    // Cold reader (restart) parses each row back; re-stringifying must not change a byte.
    const reopened = await JournalOutboxStore.open(fake.restart().plugin)
    const loaded = reopened.load()
    expect(loaded.kind).toBe('ok')
    if (loaded.kind !== 'ok') return
    expect(loaded.items).toEqual(JSON.parse(JSON.stringify(fixture)))
    loaded.items.forEach((item, i) => {
      expect(JSON.stringify(item)).toBe(JSON.stringify(fixture[i]))
      expect(JSON.stringify(item.payload)).toBe(JSON.stringify(fixture[i].payload))
    })
    expect(JSON.stringify(loaded.items.find((i) => i.idempotencyKey === 'dev:sale')!.payload)).toContain('0.30000000000000004')
    expect(JSON.stringify(loaded.items.find((i) => i.idempotencyKey === 'dev:sale')!.payload)).toContain('10.5')
  })

  it('an item produced by real Outbox operations is stored byte-exactly after every kind of settle', async () => {
    const fake = createFakeJournal()
    const outbox = new Outbox(await JournalOutboxStore.open(fake.plugin))
    await outbox.add('order', 'dev:1', { total: 10.5, tax: 0.1 + 0.2 }, env as never)
    await outbox.add('order', 'dev:2', { total: 1 })
    await outbox.add('transfer_receive', 'dev:3', { pin: '1234', items: [] }, env as never)
    await outbox.add('order', 'dev:4', { total: 2 }, env as never)
    await outbox.add('order', 'dev:5', { total: 3 }, env as never)
    await outbox.settle([
      { key: 'dev:1', op: 'ack' },
      { key: 'dev:3', op: 'review', code: 'competing_receipt', reason: 'ditolak' },
      { key: 'dev:4', op: 'fail', error: 'timeout', retryable: true },
      { key: 'dev:5', op: 'fail', error: 'boom' },
    ])
    for (const item of outbox.all()) {
      expect(fake.persisted.rows.get(item.idempotencyKey)!.json).toBe(JSON.stringify(item))
    }
    expect(fake.persisted.rows.size).toBe(5)
    const parked = persistedItems(fake.persisted).find((i) => (i as OutboxItem).idempotencyKey === 'dev:3') as OutboxItem
    expect(parked.payload).not.toHaveProperty('pin') // parking strips the PIN, and the row agrees
    expect(parked.attempts).toBe(5)
    expect(parked.reviewCode).toBe('competing_receipt')
  })
})

describe('JournalOutboxStore refuses an unsafe database', () => {
  const expectRefused = async (fake: ReturnType<typeof createFakeJournal>, code: string) => {
    const err = await JournalOutboxStore.open(fake.plugin).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(JournalUnavailableError)
    expect((err as JournalUnavailableError).code).toBe(code)
  }

  it('quick_check not ok', async () => {
    const fake = createFakeJournal()
    fake.ctl.open = { ...fake.ctl.open, quickCheck: '*** in database main ***' }
    await expectRefused(fake, 'quick_check_failed')
  })

  it('synchronous below FULL', async () => {
    for (const level of [0, 1]) {
      const fake = createFakeJournal()
      fake.ctl.open = { ...fake.ctl.open, synchronous: level }
      await expectRefused(fake, 'not_full_sync')
    }
  })

  it('journal mode that can lose a commit on power loss (wal, delete, memory, off)', async () => {
    for (const mode of ['wal', 'delete', 'memory', 'off', '']) {
      const fake = createFakeJournal()
      fake.ctl.open = { ...fake.ctl.open, journalMode: mode }
      await expectRefused(fake, 'journal_mode')
    }
  })

  it('accepts the truncate and persist journal modes (any case)', async () => {
    for (const mode of ['truncate', 'persist', 'TRUNCATE']) {
      const fake = createFakeJournal()
      fake.ctl.open = { ...fake.ctl.open, journalMode: mode }
      await expect(JournalOutboxStore.open(fake.plugin)).resolves.toBeDefined()
    }
  })

  it('open() itself failing', async () => {
    const fake = createFakeJournal()
    fake.ctl.openError = new Error('unable to open database file')
    const err = await JournalOutboxStore.open(fake.plugin).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(JournalUnavailableError)
    expect((err as JournalUnavailableError).code).toBe('open_failed')
    expect(((err as JournalUnavailableError).cause as Error).message).toContain('unable to open')
  })

  it('a row that is not a valid item for its key', async () => {
    const fake = createFakeJournal()
    fake.persisted.rows.set('dev:1', { seq: 1, json: '{"idempotencyKey":"dev:1"' })
    await expectRefused(fake, 'row_corrupt')
    const other = createFakeJournal()
    other.persisted.rows.set('dev:1', { seq: 1, json: JSON.stringify({ idempotencyKey: 'dev:2', seq: 1 }) })
    await expectRefused(other, 'row_corrupt')
  })

  it('a refused open can be retried (not cached) and a good open is a process singleton', async () => {
    const fake = createFakeJournal()
    fake.ctl.open = { ...fake.ctl.open, synchronous: 1 }
    await expectRefused(fake, 'not_full_sync')
    fake.ctl.open = { ...fake.ctl.open, synchronous: 2 }
    const a = await JournalOutboxStore.open(fake.plugin)
    const b = await JournalOutboxStore.open(fake.plugin)
    expect(b).toBe(a)
    expect(fake.ctl.opens).toBe(2) // 1 refused + 1 adopted; the second adopt reused the instance
  })

  it('accepts synchronous EXTRA (3) as at-least-FULL', async () => {
    const fake = createFakeJournal()
    fake.ctl.open = { ...fake.ctl.open, synchronous: 3 }
    await expect(JournalOutboxStore.open(fake.plugin)).resolves.toBeInstanceOf(JournalOutboxStore)
  })
})

describe('JournalOutboxStore meta kv facade', () => {
  it('serves only the synced-refunds key, durably, through apply', async () => {
    const fake = createFakeJournal()
    fake.persisted.meta.set(SYNCED_REFUNDS_KEY, '[{"orderId":"o0","at":1}]')
    const store = await JournalOutboxStore.open(fake.plugin)
    expect(store.kv.get(SYNCED_REFUNDS_KEY)).toBe('[{"orderId":"o0","at":1}]')
    await store.kv.setDurable(SYNCED_REFUNDS_KEY, '[{"orderId":"o1","at":2}]')
    expect(fake.persisted.meta.get(SYNCED_REFUNDS_KEY)).toBe('[{"orderId":"o1","at":2}]')
    expect(store.kv.get(SYNCED_REFUNDS_KEY)).toBe('[{"orderId":"o1","at":2}]')
    const last = fake.ctl.applies[fake.ctl.applies.length - 1]
    expect(last.upserts).toEqual([])
    expect(last.deletes).toEqual([])
    expect(last.meta).toEqual({ [SYNCED_REFUNDS_KEY]: '[{"orderId":"o1","at":2}]' })
    // survives a restart
    const again = await JournalOutboxStore.open(fake.restart().plugin)
    expect(again.kv.get(SYNCED_REFUNDS_KEY)).toBe('[{"orderId":"o1","at":2}]')
  })

  it('a failed apply leaves the facade value unchanged', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    await store.kv.setDurable(SYNCED_REFUNDS_KEY, 'v1')
    fake.ctl.failAt = 'beforeCommit'
    await expect(store.kv.setDurable(SYNCED_REFUNDS_KEY, 'v2')).rejects.toThrow()
    expect(store.kv.get(SYNCED_REFUNDS_KEY)).toBe('v1')
    expect(fake.persisted.meta.get(SYNCED_REFUNDS_KEY)).toBe('v1')
  })

  it('serves the receipt archive key too (A41), but still refuses to remove it', async () => {
    const ARCHIVE_KEY = 'mandalika.pos.receiptArchive'
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    expect(store.kv.get(ARCHIVE_KEY)).toBeNull()
    await store.kv.setDurable(ARCHIVE_KEY, '[1]')
    expect(store.kv.get(ARCHIVE_KEY)).toBe('[1]')
    expect(fake.persisted.meta.get(ARCHIVE_KEY)).toBe('[1]')
    store.kv.set(ARCHIVE_KEY, '[2]')
    expect(store.kv.get(ARCHIVE_KEY)).toBe('[2]')
    await expect(store.kv.removeDurable(ARCHIVE_KEY)).rejects.toThrow()
    expect(() => store.kv.remove(ARCHIVE_KEY)).toThrow()
    await store.kv.setDurable(ARCHIVE_KEY, '[3]')
    const again = await JournalOutboxStore.open(fake.restart().plugin)
    expect(again.kv.get(ARCHIVE_KEY)).toBe('[3]')
  })

  it('refuses every other key and never writes it', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    for (const key of [OUTBOX_KEY, 'mandalika.pos.deviceId', 'mandalika.outbox.corruptionNotice', 'migration']) {
      expect(store.kv.get(key)).toBeNull()
      await expect(store.kv.setDurable(key, 'x')).rejects.toThrow()
      await expect(store.kv.removeDurable(key)).rejects.toThrow()
      expect(() => store.kv.set(key, 'x')).toThrow()
    }
    expect(fake.ctl.applies).toHaveLength(0)
    expect(fake.persisted.meta.size).toBe(0)
  })

  it('does not leak other meta (e.g. migration state) through the facade', async () => {
    const fake = createFakeJournal()
    fake.persisted.meta.set('migration', 'verified')
    const store = await JournalOutboxStore.open(fake.plugin)
    expect(store.kv.get('migration')).toBeNull()
  })
})

describe('fake journal transaction semantics (M3)', () => {
  const row = (key: string, seq: number) => ({ key, seq, json: JSON.stringify({ idempotencyKey: key, seq }) })

  it('a REPLACE-style upsert would delete another sale; the fake aborts instead and keeps both rows', async () => {
    const fake = createFakeJournal()
    await fake.plugin.apply({ upserts: [row('A', 1)], deletes: [] })
    await expect(fake.plugin.apply({ upserts: [row('B', 1)], deletes: [] })).rejects.toThrow('UNIQUE')
    expect([...fake.persisted.rows.keys()]).toEqual(['A'])
  })

  it('applies deletes before upserts (a delete frees its seq for an upsert in the same batch)', async () => {
    const fake = createFakeJournal()
    await fake.plugin.apply({ upserts: [row('A', 1)], deletes: [] })
    await fake.plugin.apply({ upserts: [row('B', 1)], deletes: ['A'] })
    expect([...fake.persisted.rows.keys()]).toEqual(['B'])
  })

  it('a UNIQUE failure mid-batch rolls the whole transaction back', async () => {
    const fake = createFakeJournal()
    await fake.plugin.apply({ upserts: [row('A', 1)], deletes: [] })
    await expect(fake.plugin.apply({ upserts: [row('C', 3), row('B', 1)], deletes: [], meta: { k: 'v' } })).rejects.toThrow('UNIQUE')
    expect([...fake.persisted.rows.keys()]).toEqual(['A'])
    expect(fake.persisted.meta.size).toBe(0)
  })
})

describe('JournalOutboxStore meta facade ordering (H2)', () => {
  it('rapid SyncedRefunds.add calls never lose an entry to an older background patch', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    const refunds = new SyncedRefunds(store.kv)
    fake.ctl.mode = 'hold'
    refunds.add('o1')
    refunds.add('o2')
    await tick()
    fake.ctl.held.shift()!.resolve() // o1's apply lands while newer values are already in memory
    await tick()
    refunds.add('o3')
    for (let i = 0; i < 10; i++) { await tick(); fake.ctl.held.shift()?.resolve() }
    await tick()
    expect([...refunds.ids()].sort()).toEqual(['o1', 'o2', 'o3'])
    const persisted = JSON.parse(fake.persisted.meta.get(SYNCED_REFUNDS_KEY)!) as { orderId: string }[]
    expect(persisted.map((e) => e.orderId).sort()).toEqual(['o1', 'o2', 'o3'])
  })

  it('a failed background write is logged and memory falls back to what is on disk', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    await store.kv.setDurable(SYNCED_REFUNDS_KEY, 'v1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.ctl.mode = 'reject'
    store.kv.set(SYNCED_REFUNDS_KEY, 'v2')
    expect(store.kv.get(SYNCED_REFUNDS_KEY)).toBe('v2')
    await tick()
    await tick()
    expect(console.error).toHaveBeenCalled()
    expect(store.kv.get(SYNCED_REFUNDS_KEY)).toBe('v1')
  })
})

describe('JournalOutboxStore meta facade vs resync (HIGH-2)', () => {
  it('a failed older write does not clobber newer visible synced-refund entries', async () => {
    const fake = createFakeJournal()
    const store = await JournalOutboxStore.open(fake.plugin)
    const refunds = new SyncedRefunds(store.kv)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.ctl.mode = 'hold'
    refunds.add('o1')
    refunds.add('o2')
    await tick()
    fake.ctl.held.shift()!.reject() // o1's write fails; the resync must not touch visible meta
    await tick()
    await tick()
    expect([...refunds.ids()].sort()).toEqual(['o1', 'o2'])
    refunds.add('o3')
    for (let i = 0; i < 10; i++) { await tick(); fake.ctl.held.shift()?.resolve() }
    await tick()
    expect([...refunds.ids()].sort()).toEqual(['o1', 'o2', 'o3'])
    const disk = JSON.parse(fake.persisted.meta.get(SYNCED_REFUNDS_KEY)!) as { orderId: string }[]
    expect(disk.map((e) => e.orderId).sort()).toEqual(['o1', 'o2', 'o3'])
  })
})

describe.each([
  ['kv', kvBackend],
  ['journal', journalBackend],
] as const)('Outbox ack carries the server id over the %s store (A41)', (_name, create) => {
  it('persists ackedOrderId beside the untouched payload and drops the row on prune', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    const item = await outbox.add('order', 'dev:1', { total: 1 })
    await outbox.settle([{ key: 'dev:1', op: 'ack', orderId: 'srv-1' }])
    const [row] = b.stored() as (OutboxItem & { ackedOrderId?: string })[]
    expect(row.status).toBe('acked')
    expect(row.ackedOrderId).toBe('srv-1')
    expect(row.payload).toEqual(item.payload)
    await outbox.prune()
    expect(b.stored()).toEqual([])
  })
})

// A08: a raw approver PIN may still sit in queued transfer_receive rows written by older code. The
// scrub removes it from EVERY such row in any status (acked rows included) and touches nothing else.
describe.each([
  ['kv', kvBackend],
  ['journal', journalBackend],
] as const)('Outbox.scrubLegacySecrets over the %s store', (_name, create) => {
  it('strips payload.pin from every transfer_receive row, keeping seq, status, attempts and key', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    await outbox.add('transfer_receive', 'dev:pending', { transferId: 't1', pin: '1234', approverUserId: 'a' })
    await outbox.add('transfer_receive', 'dev:acked', { transferId: 't2', pin: '1234' })
    await outbox.add('transfer_receive', 'dev:failed', { transferId: 't3', pin: '1234' })
    await outbox.add('order', 'dev:order', { total: 1, pin: 'not-a-secret-here' })
    await outbox.settle([
      { key: 'dev:acked', op: 'ack' },
      { key: 'dev:failed', op: 'fail', error: 'boom' },
    ])
    const before = outbox.all().map((i) => ({ seq: i.seq, status: i.status, attempts: i.attempts, key: i.idempotencyKey }))

    await outbox.scrubLegacySecrets()

    for (const rows of [outbox.all(), b.stored()]) {
      for (const i of rows.filter((r) => r.type === 'transfer_receive')) expect(i.payload).not.toHaveProperty('pin')
      expect(JSON.stringify(rows)).not.toContain('"1234"')
      expect(rows.map((i) => ({ seq: i.seq, status: i.status, attempts: i.attempts, key: i.idempotencyKey }))).toEqual(before)
    }
    expect(outbox.all().find((i) => i.idempotencyKey === 'dev:pending')!.payload).toMatchObject({ transferId: 't1', approverUserId: 'a' })
    expect(outbox.all().find((i) => i.idempotencyKey === 'dev:order')!.payload).toHaveProperty('pin') // other types untouched
  })

  it('writes nothing when no row carries a PIN, and is idempotent', async () => {
    const b = await create()
    const outbox = b.newOutbox()
    await outbox.add('transfer_receive', 'dev:clean', { transferId: 't1', approvalGrantId: 'g1' })
    const writes = b.ctl.writes()
    await outbox.scrubLegacySecrets()
    expect(b.ctl.writes()).toBe(writes)
    await outbox.add('transfer_receive', 'dev:old', { transferId: 't2', pin: '9999' })
    await outbox.scrubLegacySecrets()
    const after = b.ctl.writes()
    await outbox.scrubLegacySecrets()
    expect(b.ctl.writes()).toBe(after)
  })
})
