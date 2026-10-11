import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, ENVELOPE_REFUSED_MESSAGE, type ApiLike, type KV } from '@mandalika/sync'
import { releaseBlockedReason } from './terminalBinding'

// N1: in a terminal/outlet mismatch a FLUSH-ONLY engine drains what is already queued (so Lepas
// terminal can unlock) while capture stays refused.

function memKV(): KV {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k),
    setDurable: async (k, v) => void m.set(k, v), removeDurable: async (k) => void m.delete(k),
  }
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

const stamped = { v: 1, outletId: 'outlet-old', userId: 'me', deviceId: 'd', capturedAt: '2026-10-11T00:00:00Z' } as const
const blockedFor = (e: SyncEngine) => {
  const s = e.queueSummary()
  return releaseBlockedReason({ pending: s.pending, parkedUnstamped: s.parkedUnstamped, corrupted: false, online: true })
}

describe('flush-only engine in a terminal mismatch', () => {
  it('refuses capture, drains a stamped item to review, then Lepas terminal unlocks (nothing deleted)', async () => {
    const calls: string[] = []
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`)
      if (path.endsWith('/sync/version')) return { data: { version: 0 } }
      const key = (body as { items: { idempotencyKey: string }[] }).items[0].idempotencyKey
      return {
        data: { processed: 0, version: 0, results: [{ idempotencyKey: key, status: 'error', code: 'actor_mismatch', retryable: false, error: 'Akun ini tidak berwenang untuk outlet pada transaksi ini' }] },
      }
    })
    const engine = new SyncEngine({ request } as unknown as ApiLike, {}, memKV(), { actor: () => null }) // mismatch: no outlet in effect
    await engine.outbox.add('order', 'd:old', { total: 1 }, stamped)
    expect(engine.queueSummary()).toMatchObject({ pending: 1, parkedStamped: 0 })
    expect(blockedFor(engine)).not.toBeNull() // locked while it is still waiting

    // capture and optimistic credits are refused, nothing is stored
    await expect(engine.enqueue('order', { total: 2 })).rejects.toThrow(ENVELOPE_REFUSED_MESSAGE)
    await expect(engine.enqueueTransferReceive({ transferId: 't', items: [{ productId: 'p', variantSize: 'M', receivedQty: 1 }], approverUserId: 'a', pin: '1' })).rejects.toThrow(ENVELOPE_REFUSED_MESSAGE)
    expect(engine.outbox.all()).toHaveLength(1)
    expect(engine.pending.list()).toHaveLength(0)

    const stop = engine.start(60_000, { flushOnly: true })
    await vi.waitFor(() => expect(engine.reviewItems()).toHaveLength(1))
    stop()
    expect(engine.reviewItems()[0]).toMatchObject({ reviewCode: 'actor_mismatch', ownerUserId: 'me' })
    expect(engine.queueSummary()).toMatchObject({ pending: 0, parkedStamped: 1, parkedUnstamped: 0 })
    expect(blockedFor(engine)).toBeNull() // Lepas terminal is enabled
    expect(engine.outbox.all()).toHaveLength(1) // kept, never deleted
    expect(calls.some((c) => c.includes('inbound-transfers') || c.includes('/sync/pull'))).toBe(false)
  })

  it('an already-applied stamped item replays as duplicate and leaves the queue', async () => {
    const request = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path.endsWith('/sync/version')) return { data: { version: 0 } }
      const key = (body as { items: { idempotencyKey: string }[] }).items[0].idempotencyKey
      return { data: { processed: 1, version: 0, results: [{ idempotencyKey: key, status: 'duplicate', orderId: 'o1' }] } }
    })
    const engine = new SyncEngine({ request } as unknown as ApiLike, {}, memKV(), { actor: () => null })
    await engine.outbox.add('order', 'd:old', { total: 1 }, stamped)
    const stop = engine.start(60_000, { flushOnly: true })
    await vi.waitFor(() => expect(engine.unsettledCount()).toBe(0))
    stop()
    expect(blockedFor(engine)).toBeNull()
  })
})
