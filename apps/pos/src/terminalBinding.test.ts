import { describe, expect, it } from 'vitest'
import type { KV } from '@mandalika/sync'
import { OUTBOX_KEY } from '@mandalika/sync'
import { USER_KEY } from './authBoot'
import {
  TERMINAL_KEY,
  bindingFor,
  checkLoginAllowed,
  clearBinding,
  clearOutletCaches,
  isQueueEmpty,
  readBinding,
  readQueueState,
  releaseBlockedReason,
  sameBinding,
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

const queue = (...statuses: string[]) => JSON.stringify(statuses.map((status, i) => ({ idempotencyKey: `d:${i}`, status })))
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
  it('removes the previous outlet data but not the outbox, device id or session', () => {
    const kv = memKV({
      'mandalika.pos.snapshot': '{}', 'mandalika.pos.contentVersion': '3', 'mandalika.pos.inboundTransfers': '[]',
      'mandalika.pos.pendingCredits': '[]', [OUTBOX_KEY]: '[]', 'mandalika.pos.deviceId': 'dev', 'mandalika.pos.refresh': 'r',
    })
    clearOutletCaches(kv)
    expect(kv.get('mandalika.pos.snapshot')).toBeNull()
    expect(kv.get('mandalika.pos.contentVersion')).toBeNull()
    expect(kv.get('mandalika.pos.inboundTransfers')).toBeNull()
    expect(kv.get('mandalika.pos.pendingCredits')).toBeNull()
    expect(kv.get(OUTBOX_KEY)).toBe('[]')
    expect(kv.get('mandalika.pos.deviceId')).toBe('dev')
    expect(kv.get('mandalika.pos.refresh')).toBe('r')
  })
})

describe('bindingFor: where the terminal sells', () => {
  it('an account with a stored outlet always uses it', () => {
    expect(bindingFor(cashier, binding({ outletId: 'out-1' }))).toMatchObject({ outletId: 'out-9', ownerUserId: 'u-c', ownerName: 'Yasmine', outletName: null })
    expect(bindingFor(cashier, null)?.outletId).toBe('out-9')
  })

  it('an outlet-less account on an unbound terminal must pick (null)', () => {
    expect(bindingFor(adminUser, null)).toBeNull()
  })

  it('an outlet-less account inherits the terminal outlet and keeps its name and bind time', () => {
    const b = bindingFor({ id: 'u-b', displayName: 'Admin B', outletId: undefined, role: 'admin' }, binding())
    expect(b).toMatchObject({ outletId: 'out-1', outletName: 'BSD', ownerUserId: 'u-b', ownerName: 'Admin B', boundAt: '2026-10-11T00:00:00.000Z' })
  })

  it('a non-admin without an outlet never gets one: not from a pick, not from the terminal', () => {
    const unassigned = { id: 'u-m', displayName: 'Manajer', outletId: null, role: 'manager' as const }
    expect(bindingFor(unassigned, null)).toBeNull()
    expect(bindingFor(unassigned, binding())).toBeNull()
    expect(bindingFor(unassigned, null, { id: 'out-2', name: 'PMS' })).toBeNull()
    expect(bindingFor({ ...unassigned, role: 'cashier' }, binding())).toBeNull()
  })

  it('a pick becomes the terminal outlet with its name', () => {
    const b = bindingFor(adminUser, null, { id: 'out-2', name: 'PMS' }, () => 'NOW')
    expect(b).toEqual({ outletId: 'out-2', outletName: 'PMS', ownerUserId: 'u-a', ownerName: 'Admin A', boundAt: 'NOW' })
  })

  it('sameBinding detects owner or outlet changes', () => {
    expect(sameBinding(binding(), binding())).toBe(true)
    expect(sameBinding(binding(), binding({ ownerUserId: 'x' }))).toBe(false)
    expect(sameBinding(binding(), binding({ outletId: 'x' }))).toBe(false)
    expect(sameBinding(null, null)).toBe(true)
    expect(sameBinding(binding(), null)).toBe(false)
  })
})

describe('readQueueState reads the durable outbox without an engine', () => {
  it('missing or empty = empty', () => {
    expect(isQueueEmpty(readQueueState(memKV()))).toBe(true)
    expect(isQueueEmpty(readQueueState(memKV({ [OUTBOX_KEY]: '[]' })))).toBe(true)
  })

  it('counts everything not acknowledged: pending, failed and parked', () => {
    expect(readQueueState(memKV({ [OUTBOX_KEY]: queue('pending', 'failed', 'acked', 'sent') }))).toEqual({ count: 3, readable: true })
    expect(isQueueEmpty(readQueueState(memKV({ [OUTBOX_KEY]: queue('acked') })))).toBe(true)
  })

  it('a parse failure is NOT empty', () => {
    for (const raw of ['{broken', '{"a":1}', '"x"', '12']) {
      const q = readQueueState(memKV({ [OUTBOX_KEY]: raw }))
      expect(q.readable).toBe(false)
      expect(isQueueEmpty(q)).toBe(false)
    }
  })
})

describe('checkLoginAllowed: a different account may not take over a non-empty terminal', () => {
  const withQueue = (extra: Record<string, string> = {}) => memKV({ [OUTBOX_KEY]: queue('pending', 'failed'), ...extra })

  it('an empty queue lets anyone in', () => {
    expect(checkLoginAllowed(memKV({ [TERMINAL_KEY]: JSON.stringify(binding()) }), cashier)).toEqual({ ok: true })
  })

  it('the owner may always sign back in', () => {
    const kv = withQueue({ [TERMINAL_KEY]: JSON.stringify(binding()) })
    expect(checkLoginAllowed(kv, { id: 'u-a' })).toEqual({ ok: true })
  })

  it('another account is refused with a message naming the owner and the count', () => {
    const kv = withQueue({ [TERMINAL_KEY]: JSON.stringify(binding()) })
    const v = checkLoginAllowed(kv, cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.message).toContain('Admin A')
      expect(v.message).toContain('2 transaksi')
    }
  })

  it('an unreadable queue refuses another account (parse failure = not empty)', () => {
    const kv = memKV({ [OUTBOX_KEY]: '{broken', [TERMINAL_KEY]: JSON.stringify(binding()) })
    const v = checkLoginAllowed(kv, cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('tidak terbaca')
  })

  it('a tablet upgraded from before bindings falls back to the last cached profile', () => {
    const cached = JSON.stringify({ id: 'u-old', displayName: 'Kasir Lama' })
    const kv = withQueue({ [USER_KEY]: cached })
    const v = checkLoginAllowed(kv, cashier)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('Kasir Lama')
    expect(checkLoginAllowed(kv, { id: 'u-old' })).toEqual({ ok: true })
  })

  it('with no owner to compare, nobody is locked out of their own queue', () => {
    expect(checkLoginAllowed(withQueue(), cashier)).toEqual({ ok: true })
  })
})

describe('releaseBlockedReason (Lepas terminal guard)', () => {
  it('only an empty, readable queue while online may release', () => {
    expect(releaseBlockedReason({ unsettled: 0, corrupted: false, online: true })).toBeNull()
    expect(releaseBlockedReason({ unsettled: 2, corrupted: false, online: true })).toContain('2 transaksi')
    expect(releaseBlockedReason({ unsettled: 0, corrupted: true, online: true })).toContain('rusak')
    expect(releaseBlockedReason({ unsettled: 0, corrupted: false, online: false })).toContain('internet')
  })

  it('a queue with parked/review items also blocks (unsettled counts them)', () => {
    expect(releaseBlockedReason({ unsettled: 1, corrupted: false, online: false })).toContain('1 transaksi')
  })
})
