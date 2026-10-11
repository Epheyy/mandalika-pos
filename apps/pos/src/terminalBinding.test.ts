import { describe, expect, it } from 'vitest'
import type { KV } from '@mandalika/sync'
import { OUTBOX_KEY } from '@mandalika/sync'
import { USER_KEY } from './authBoot'
import {
  TERMINAL_KEY,
  checkLoginAllowed,
  clearBinding,
  clearOutletCaches,
  isQueueReleasable,
  ownerLabel,
  queueCount,
  readBinding,
  readQueueState,
  releaseBlockedReason,
  resolveTerminal,
  sameBinding,
  shiftCacheKeyFor,
  withOutletName,
  writeBinding,
  type TerminalBinding,
} from './terminalBinding'

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

const stamp = (userId: string) => ({ v: 1, outletId: 'out-1', userId, deviceId: 'd', capturedAt: 'x' })
const item = (status: string, over: Record<string, unknown> = {}) => ({ idempotencyKey: `d:${Math.random()}`, status, ...over })
const parked = (over: Record<string, unknown> = {}) => item('failed', { attempts: 5, ...over })
const queue = (...items: unknown[]) => JSON.stringify(items)
const binding = (over: Partial<TerminalBinding> = {}): TerminalBinding => ({
  outletId: 'out-1', outletName: 'BSD', ownerUserId: 'u-a', ownerName: 'Admin A', boundAt: '2026-10-11T00:00:00.000Z', ...over,
})
const adminUser = { id: 'u-a', displayName: 'Admin A', outletId: null, role: 'admin' as const }
const cashier = { id: 'u-c', displayName: 'Yasmine', outletId: 'out-9', role: 'cashier' as const }

describe('binding storage', () => {
  it('round-trips durably and clears', async () => {
    const kv = memKV()
    await writeBinding(kv, binding())
    expect(readBinding(kv)).toEqual(binding())
    await clearBinding(kv)
    expect(kv.get(TERMINAL_KEY)).toBeNull()
    expect(readBinding(kv)).toBeNull()
  })

  it('treats malformed stored values as absent', () => {
    for (const raw of ['not json', '[]', 'null', '{}', JSON.stringify({ outletId: '', ownerUserId: 'u', ownerName: 'n' }), JSON.stringify({ outletId: 'o' })]) {
      expect(readBinding(memKV({ [TERMINAL_KEY]: raw }))).toBeNull()
    }
  })
})

describe('clearOutletCaches', () => {
  it('removes the previous outlet data and its shift cache, but not the outbox, device id or session', () => {
    const kv = memKV({
      'mandalika.pos.snapshot': '{}', 'mandalika.pos.contentVersion': '3', 'mandalika.pos.inboundTransfers': '[]',
      'mandalika.pos.pendingCredits': '[]', [shiftCacheKeyFor('out-1')]: '{}', [shiftCacheKeyFor('out-2')]: '{}',
      [OUTBOX_KEY]: '[]', 'mandalika.pos.deviceId': 'dev', 'mandalika.pos.refresh': 'r',
    })
    clearOutletCaches(kv, 'out-1')
    for (const k of ['mandalika.pos.snapshot', 'mandalika.pos.contentVersion', 'mandalika.pos.inboundTransfers', 'mandalika.pos.pendingCredits', shiftCacheKeyFor('out-1')]) {
      expect(kv.get(k)).toBeNull()
    }
    expect(kv.get(shiftCacheKeyFor('out-2'))).toBe('{}')
    expect(kv.get(OUTBOX_KEY)).toBe('[]')
    expect(kv.get('mandalika.pos.deviceId')).toBe('dev')
    expect(kv.get('mandalika.pos.refresh')).toBe('r')
  })
})

describe('resolveTerminal: a bound terminal is never rebound', () => {
  it('an unbound terminal binds a fixed-outlet account to its stored outlet (created)', () => {
    const r = resolveTerminal(cashier, null, undefined, () => 'NOW')
    expect(r).toEqual({ state: 'ok', created: true, binding: { outletId: 'out-9', outletName: null, ownerUserId: 'u-c', ownerName: 'Yasmine', boundAt: 'NOW' } })
  })

  it('a matching account keeps the binding (only the owner changes), nothing created', () => {
    const r = resolveTerminal(cashier, binding({ outletId: 'out-9', outletName: 'Pondok' }))
    expect(r).toMatchObject({ state: 'ok', created: false, binding: { outletId: 'out-9', outletName: 'Pondok', ownerUserId: 'u-c', boundAt: '2026-10-11T00:00:00.000Z' } })
  })

  it('a non-admin whose outlet differs is a MISMATCH and the existing binding comes back untouched', () => {
    const b = binding({ outletId: 'out-1' })
    const r = resolveTerminal(cashier, b)
    expect(r.state).toBe('mismatch')
    expect(r.binding).toEqual(b) // not rebound, owner not taken over
    expect(r.created).toBe(false)
  })

  it('token refresh or boot with a different outlet cannot rebind: it resolves to mismatch again, whatever the call site', () => {
    const b = binding({ outletId: 'out-1' })
    for (let i = 0; i < 3; i++) expect(resolveTerminal(cashier, b).state).toBe('mismatch')
  })

  it('an admin always uses the binding, even with a home outlet of their own', () => {
    const adminWithHome = { ...adminUser, outletId: 'out-77' }
    const r = resolveTerminal(adminWithHome, binding())
    expect(r).toMatchObject({ state: 'ok', created: false, binding: { outletId: 'out-1' } })
  })

  it('an outlet-less admin on an unbound terminal must pick; a pick creates the binding with its name', () => {
    expect(resolveTerminal(adminUser, null)).toEqual({ state: 'pick', binding: null, created: false })
    const r = resolveTerminal(adminUser, null, { id: 'out-2', name: 'PMS' }, () => 'NOW')
    expect(r).toEqual({ state: 'ok', created: true, binding: { outletId: 'out-2', outletName: 'PMS', ownerUserId: 'u-a', ownerName: 'Admin A', boundAt: 'NOW' } })
  })

  it('a pick cannot override an existing binding', () => {
    expect(resolveTerminal(adminUser, binding(), { id: 'out-2', name: 'PMS' }).binding?.outletId).toBe('out-1')
  })

  it('a non-admin without an outlet is unassigned: not from a pick, not from the terminal', () => {
    const unassigned = { id: 'u-m', displayName: 'Manajer', outletId: null, role: 'manager' as const }
    for (const current of [null, binding()]) {
      expect(resolveTerminal(unassigned, current).state).toBe('unassigned')
      expect(resolveTerminal(unassigned, current, { id: 'out-2', name: 'PMS' }).state).toBe('unassigned')
    }
  })

  it('sameBinding and withOutletName', () => {
    expect(sameBinding(binding(), binding())).toBe(true)
    expect(sameBinding(binding(), binding({ ownerUserId: 'x' }))).toBe(false)
    expect(sameBinding(null, null)).toBe(true)
    expect(sameBinding(binding(), null)).toBe(false)
    expect(withOutletName(binding({ outletName: null }), 'Mandalika BSD')).toMatchObject({ outletName: 'Mandalika BSD' })
    expect(withOutletName(binding({ outletName: 'BSD' }), 'BSD')).toBeNull()
    expect(withOutletName(binding(), null)).toBeNull()
  })
})

describe('readQueueState reads the durable outbox without an engine', () => {
  it('missing or empty = releasable', () => {
    expect(isQueueReleasable(readQueueState(memKV()))).toBe(true)
    expect(isQueueReleasable(readQueueState(memKV({ [OUTBOX_KEY]: '[]' })))).toBe(true)
  })

  it('classifies pending, stamped-parked and unstamped-parked; acked is ignored', () => {
    const q = readQueueState(memKV({ [OUTBOX_KEY]: queue(item('pending'), item('failed', { attempts: 1 }), parked({ envelope: stamp('u-a') }), parked(), item('acked')) }))
    expect(q).toMatchObject({ readable: true, pending: 2, parkedStamped: 1, parkedUnstamped: 1, owners: ['u-a'] })
    expect(queueCount(q)).toBe(4)
  })

  it('a parse failure is NOT releasable', () => {
    for (const raw of ['{broken', '{"a":1}', '"x"', '12']) {
      const q = readQueueState(memKV({ [OUTBOX_KEY]: raw }))
      expect(q.readable).toBe(false)
      expect(isQueueReleasable(q)).toBe(false)
    }
  })
})

describe('checkLoginAllowed (H1): only stamped review items leave the terminal unlocked', () => {
  const withBinding = { [TERMINAL_KEY]: JSON.stringify(binding()) }

  it('an empty queue lets anyone in', () => {
    expect(checkLoginAllowed(memKV(withBinding), cashier)).toEqual({ ok: true })
  })

  it('only stamped parked items: another account may sign in (they stay in the outbox)', () => {
    const kv = memKV({ ...withBinding, [OUTBOX_KEY]: queue(parked({ envelope: stamp('u-a') }), parked({ envelope: stamp('u-a') })) })
    expect(checkLoginAllowed(kv, cashier)).toEqual({ ok: true })
  })

  it('a pending item keeps the lock; the owner may always sign back in', () => {
    const kv = memKV({ ...withBinding, [OUTBOX_KEY]: queue(item('pending', { envelope: stamp('u-a') }), parked({ envelope: stamp('u-a') })) })
    const v = checkLoginAllowed(kv, cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.message).toContain('Admin A')
      expect(v.message).toContain('2 transaksi')
    }
    expect(checkLoginAllowed(kv, { id: 'u-a' })).toEqual({ ok: true })
  })

  it('a parked item WITHOUT an envelope keeps the lock', () => {
    const kv = memKV({ ...withBinding, [OUTBOX_KEY]: queue(parked({ envelope: stamp('u-a') }), parked()) })
    expect(checkLoginAllowed(kv, cashier).ok).toBe(false)
  })

  it('an unreadable queue refuses another account', () => {
    const v = checkLoginAllowed(memKV({ ...withBinding, [OUTBOX_KEY]: '{broken' }), cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('tidak terbaca')
  })

  it('without a binding the owner falls back to the cached profile, then to the queued envelopes', () => {
    const pending = queue(item('pending', { envelope: stamp('u-env') }))
    const cached = memKV({ [OUTBOX_KEY]: pending, [USER_KEY]: JSON.stringify({ id: 'u-old', displayName: 'Kasir Lama' }) })
    const v = checkLoginAllowed(cached, cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('Kasir Lama')
    const envOnly = memKV({ [OUTBOX_KEY]: pending })
    const w = checkLoginAllowed(envOnly, cashier)
    expect(w.ok).toBe(false)
    if (!w.ok) expect(w.message).toContain('u-env')
    expect(checkLoginAllowed(envOnly, { id: 'u-env' })).toEqual({ ok: true })
  })

  it('with no owner to compare at all, nobody is locked out of their own queue', () => {
    expect(checkLoginAllowed(memKV({ [OUTBOX_KEY]: queue(item('pending')) }), cashier)).toEqual({ ok: true })
  })
})

describe('releaseBlockedReason (Lepas terminal guard)', () => {
  const base = { pending: 0, parkedUnstamped: 0, corrupted: false, online: true }
  it('allowed when nothing is pending or unowned, online', () => {
    expect(releaseBlockedReason(base)).toBeNull()
  })
  it('pending or unstamped-parked items, a corrupt queue and offline all block', () => {
    expect(releaseBlockedReason({ ...base, pending: 2 })).toContain('2 transaksi')
    expect(releaseBlockedReason({ ...base, parkedUnstamped: 1 })).toContain('1 transaksi')
    expect(releaseBlockedReason({ ...base, corrupted: true })).toContain('rusak')
    expect(releaseBlockedReason({ ...base, online: false })).toContain('internet')
  })
})

describe('ownerLabel', () => {
  it('uses the staff name from the snapshot, else the id', () => {
    expect(ownerLabel('u1', [{ id: 'u1', displayName: 'Yasmine' }])).toBe('Yasmine')
    expect(ownerLabel('u2', [{ id: 'u1', displayName: 'Yasmine' }])).toBe('u2')
    expect(ownerLabel('u2', null)).toBe('u2')
  })
})
