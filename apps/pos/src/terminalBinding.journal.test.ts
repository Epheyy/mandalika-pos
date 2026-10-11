import { describe, expect, it } from 'vitest'
import { JournalOutboxStore, KVOutboxStore, OUTBOX_KEY, type KV } from '@mandalika/sync'
import { createFakeJournal } from '../../../packages/sync/src/testFixtures/fakeJournal'
import { TERMINAL_KEY, checkLoginAllowed, isQueueReleasable, readQueueState, type TerminalBinding } from './terminalBinding'

// A01b: with the journal the outbox key in Preferences is only a sentinel, so the login/release guards
// must read the queue from the store the app runs on, never from that key.

function memKV(seed: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(seed))
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v),
    removeDurable: async (k) => void m.delete(k),
  }
}
const SENTINEL = JSON.stringify({ movedTo: 'journal', v: 1, at: 'x', count: 1, sha256: 'x' })
const binding: TerminalBinding = { outletId: 'out-1', outletName: 'BSD', ownerUserId: 'u-a', ownerName: 'Admin A', boundAt: 'x' }
const stamped = { v: 1, outletId: 'out-1', userId: 'u-a', deviceId: 'd', capturedAt: 'x' }

async function journalWith(items: { idempotencyKey: string; status: string; envelope?: object }[], prefs: KV) {
  const fj = createFakeJournal()
  items.forEach((it, n) => {
    const item = { seq: n + 1, ...it } as { idempotencyKey: string; seq: number }
    fj.persisted.rows.set(item.idempotencyKey, { seq: n + 1, json: JSON.stringify(item) })
  })
  return JournalOutboxStore.open(fj.plugin, prefs)
}

describe('guards over the journal store', () => {
  it('pending journal items refuse a different account and the release, though Preferences holds only the sentinel', async () => {
    const prefs = memKV({ [OUTBOX_KEY]: SENTINEL, [TERMINAL_KEY]: JSON.stringify(binding) })
    const store = await journalWith([{ idempotencyKey: 'd:1', status: 'pending', envelope: stamped }], prefs)
    const q = readQueueState(store)
    expect(q).toMatchObject({ readable: true, pending: 1 })
    expect(isQueueReleasable(q)).toBe(false)
    const verdict = checkLoginAllowed(store, { id: 'u-b' })
    expect(verdict.ok).toBe(false)
    expect(checkLoginAllowed(store, { id: 'u-a' }).ok).toBe(true)
  })
  it('an empty journal is releasable', async () => {
    const prefs = memKV({ [OUTBOX_KEY]: SENTINEL })
    const store = await journalWith([], prefs)
    expect(isQueueReleasable(readQueueState(store))).toBe(true)
  })
  it('the sentinel read as a bare KV (or through the KV store) is an unreadable, non-empty queue', () => {
    const prefs = memKV({ [OUTBOX_KEY]: SENTINEL })
    expect(readQueueState(prefs)).toMatchObject({ readable: false })
    expect(readQueueState(new KVOutboxStore(prefs))).toMatchObject({ readable: false })
  })
  it('the KV store keeps today\'s behaviour', () => {
    const prefs = memKV({ [OUTBOX_KEY]: JSON.stringify([{ idempotencyKey: 'd:1', status: 'pending' }]) })
    expect(readQueueState(new KVOutboxStore(prefs))).toMatchObject({ readable: true, pending: 1 })
  })
})
