import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { KV, PendingShiftOp } from '@mandalika/sync'
import { canOpenShift, isPendingOpen, opsSignature, planOpsUpdate, overlayShift, readShiftCache, shiftCacheKey, shouldAutoOpen, writeShiftCache } from './shiftView'

type Shift = components['schemas']['Shift']

function memKV(): KV {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v), removeDurable: async (k) => void m.delete(k),
  }
}
const server = (over: Partial<Shift> = {}): Shift => ({
  id: 'shift-1', outletId: 'out-1', cashierId: 'u', cashierName: 'Kasir', status: 'open', openedAt: '2026-10-11T01:00:00Z',
  startingCash: 50000, totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0, ...over,
})
const op = (type: PendingShiftOp['type'], key: string, payload: Record<string, unknown>, parked = false): PendingShiftOp => ({
  type, idempotencyKey: key, payload, clientCreatedAt: '2026-10-11T02:00:00Z', parked,
})
const ctx = { outletId: 'out-1', cashierId: 'u', cashierName: 'Kasir' }

describe('last-known shift cache (per outlet)', () => {
  it('round-trips and is keyed by outlet', () => {
    const kv = memKV()
    writeShiftCache(kv, 'out-1', server())
    expect(readShiftCache(kv, 'out-1')).toEqual(server())
    expect(readShiftCache(kv, 'out-2')).toBeNull()
    expect(kv.get(shiftCacheKey('out-1'))).not.toBeNull()
  })

  it('no shift from the server clears the cache; closed or junk is never trusted', () => {
    const kv = memKV()
    writeShiftCache(kv, 'out-1', server())
    writeShiftCache(kv, 'out-1', null)
    expect(readShiftCache(kv, 'out-1')).toBeNull()
    writeShiftCache(kv, 'out-1', server({ status: 'closed' }))
    expect(readShiftCache(kv, 'out-1')).toBeNull()
    kv.set(shiftCacheKey('out-1'), '{broken')
    expect(readShiftCache(kv, 'out-1')).toBeNull()
    kv.set(shiftCacheKey('out-1'), JSON.stringify(server({ id: '' })))
    expect(readShiftCache(kv, 'out-1')).toBeNull()
    expect(readShiftCache(kv, null)).toBeNull()
  })
})

describe('overlayShift: pending opens/closes on top of the last known shift', () => {
  it('no ops: the server shift as it is', () => {
    expect(overlayShift(server(), [], ctx)).toEqual(server())
    expect(overlayShift(null, [], ctx)).toBeNull()
  })

  it('an offline open shows an active shift without an id, so Buka Shift is not offered twice', () => {
    const s = overlayShift(null, [op('shift_open', 'k1', { startingCash: 25000, outletName: 'BSD' })], ctx)
    expect(s).toMatchObject({ id: '', status: 'open', startingCash: 25000, outletName: 'BSD', cashierName: 'Kasir', openedAt: '2026-10-11T02:00:00Z' })
    expect(isPendingOpen(s)).toBe(true)
    expect(isPendingOpen(server())).toBe(false)
  })

  it('a pending open never replaces or doubles a shift the server already has', () => {
    expect(overlayShift(server(), [op('shift_open', 'k1', { startingCash: 1 })], ctx)).toEqual(server())
  })

  it('a pending close of the known shift hides it', () => {
    expect(overlayShift(server(), [op('shift_close', 'k2', { shiftId: 'shift-1', closingCash: 1 })], ctx)).toBeNull()
    expect(overlayShift(server(), [op('shift_close', 'k2', { shiftId: 'other', closingCash: 1 })], ctx)).toEqual(server())
  })

  it('close then reopen leaves the new pending shift', () => {
    const s = overlayShift(server(), [
      op('shift_close', 'k2', { shiftId: 'shift-1', closingCash: 1 }),
      op('shift_open', 'k3', { startingCash: 7 }),
    ], ctx)
    expect(s).toMatchObject({ id: '', startingCash: 7 })
  })

  it('parked operations are ignored because they will not be sent', () => {
    expect(overlayShift(null, [op('shift_open', 'k1', {}, true)], ctx)).toBeNull()
    expect(overlayShift(server(), [op('shift_close', 'k2', { shiftId: 'shift-1' }, true)], ctx)).toEqual(server())
  })

  it('tolerates a malformed starting cash', () => {
    expect(overlayShift(null, [op('shift_open', 'k1', { startingCash: 'x' })], ctx)?.startingCash).toBe(0)
  })
})

describe('opsSignature', () => {
  it('changes when an operation is acknowledged or parked', () => {
    const a = op('shift_open', 'k1', {})
    expect(opsSignature([a])).not.toBe(opsSignature([]))
    expect(opsSignature([a])).not.toBe(opsSignature([{ ...a, parked: true }]))
    expect(opsSignature([a])).toBe(opsSignature([{ ...a }]))
  })
})

describe('shouldAutoOpen: only on facts, never on a failed fetch', () => {
  const base = { enabled: true, fetchedThisSession: true, hasShift: false, isOpening: false, alreadyTried: false, online: true }
  it('opens when enabled, fetched this session, online and nothing is showing', () => {
    expect(shouldAutoOpen(base)).toBe(true)
  })
  it.each([
    ['setting off', { enabled: false }],
    ['no successful fetch this session (offline start)', { fetchedThisSession: false }],
    ['a shift is already showing (cached or pending)', { hasShift: true }],
    ['already opening', { isOpening: true }],
    ['already tried once', { alreadyTried: true }],
    ['offline', { online: false }],
  ])('does not open: %s', (_name, over) => {
    expect(shouldAutoOpen({ ...base, ...over })).toBe(false)
  })
})

describe('planOpsUpdate: the overlay is dropped only after a fresh server shift (M1)', () => {
  const a = op('shift_open', 'k1', {})
  const b = op('shift_close', 'k2', { shiftId: 's' })
  it('no change', () => expect(planOpsUpdate([a], [{ ...a }])).toBe('none'))
  it('a newly queued op shows at once', () => expect(planOpsUpdate([], [a])).toBe('apply'))
  it('an acknowledged op needs a refetch before the overlay goes (old behaviour applied immediately)', () => {
    expect(planOpsUpdate([a], [])).toBe('fetch-then-apply')
    expect(planOpsUpdate([a, b], [b])).toBe('fetch-then-apply')
  })
  it('an op that becomes parked also needs a refetch', () => {
    expect(planOpsUpdate([a], [{ ...a, parked: true }])).toBe('fetch-then-apply')
  })
  it('is decided against what is displayed, so a failed fetch retries on the next tick', () => {
    const shown = [a]
    expect(planOpsUpdate(shown, [])).toBe('fetch-then-apply')
    expect(planOpsUpdate(shown, [])).toBe('fetch-then-apply') // nothing was applied: still pending
  })
})

describe('canOpenShift (M2)', () => {
  it('needs reachability AND a successful shift fetch this session', () => {
    expect(canOpenShift(true, true)).toBe(true)
    expect(canOpenShift(true, false)).toBe(false)
    expect(canOpenShift(false, true)).toBe(false)
    expect(canOpenShift(false, false)).toBe(false)
  })
})
