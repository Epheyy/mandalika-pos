import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_ATTEMPTS, type OutboxItem } from './outbox'
import { refundPermissionError, refundPermissionFixture } from './testFixtures/refundPermission'

function captured(item: OutboxItem) {
  const { status: _status, attempts: _attempts, lastError: _lastError, ...evidence } = item
  return evidence
}

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('A06 permission containment: retained refund delivery failures', () => {
  it('retains capture evidence through five denials, repeated export, reconstruction and original-key retry', async () => {
    const onDeadLetter = vi.fn()
    const f = refundPermissionFixture({ onDeadLetter })
    // flush settles results through outbox.settle(); ack/discard ops would be the
    // only way to resolve the parked refund, so none may ever be requested.
    const settle = vi.spyOn(f.engine.outbox, 'settle')
    const resolving = () => settle.mock.calls.flatMap(([ops]) => ops).filter((o) => o.op !== 'fail')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await f.engine.flush()
      expect(result?.processed).toBe(0)
      expect(result?.results).toEqual([{ idempotencyKey: f.original.idempotencyKey, status: 'error', error: refundPermissionError }])
      expect(f.engine.outbox.all()).toHaveLength(1)
      expect(captured(f.engine.outbox.all()[0])).toEqual(captured(f.original))
      expect(f.engine.outbox.all()[0]).toMatchObject({ status: 'failed', attempts: attempt, lastError: refundPermissionError })
      expect(f.engine.pendingCount()).toBe(attempt < MAX_ATTEMPTS ? 1 : 0)
      expect(f.engine.deadLettered()).toHaveLength(attempt < MAX_ATTEMPTS ? 0 : 1)
    }
    expect(resolving()).toEqual([])
    expect(f.delivery.mutationCalls).toBe(0)
    expect(onDeadLetter).toHaveBeenCalledTimes(1)
    const parked = structuredClone(f.engine.outbox.all())
    const stored = f.store.get('mandalika.pos.outbox')
    for (let n = 0; n < 2; n++) {
      expect(JSON.parse(f.engine.buildFailedSyncDiagnostics())).toEqual(parked)
      expect(f.engine.outbox.all()).toEqual(parked)
      expect(f.store.get('mandalika.pos.outbox')).toBe(stored)
    }
    const reconstructed = f.reconstruct()
    expect(reconstructed.outbox.all()).toEqual(parked)
    expect(reconstructed.pendingCount()).toBe(0)
    expect(reconstructed.deadLettered()).toHaveLength(1)
    expect(await reconstructed.flush()).toBeNull() // parked does not auto-retry
    expect(f.sent).toHaveLength(5)
    f.delivery.permission = true // same synthetic identity/scope, no recapture
    await reconstructed.retryFailed()
    await vi.waitFor(() => expect(reconstructed.outbox.all()).toEqual([]))
    expect(f.delivery.mutationCalls).toBe(1)
    expect(f.sent).toHaveLength(6)
    for (const items of f.sent) {
      expect(items).toEqual([{ type: 'refund', idempotencyKey: f.original.idempotencyKey, payload: f.original.payload }])
    }
  })

  it('keeps an ambiguous prior commit unresolved when later delivery is denied', async () => {
    const f = refundPermissionFixture()
    f.delivery.permission = true
    f.delivery.loseNextResponse = true
    expect(await f.engine.flush()).toBeNull()
    expect(f.delivery.mutationCalls).toBe(1) // simulated commit, not a real payout
    expect(f.engine.outbox.all()[0].lastError).toContain('response lost')
    // flush settles results through outbox.settle(); ack/discard ops would be the
    // only way to resolve the parked refund, so none may ever be requested.
    const settle = vi.spyOn(f.engine.outbox, 'settle')
    const resolving = () => settle.mock.calls.flatMap(([ops]) => ops).filter((o) => o.op !== 'fail')
    f.delivery.permission = false
    // The lost response was a transient failure: no attempt was burned and a backoff
    // is running, so a person's "send now" is what drives the five denials.
    expect(f.engine.outbox.all()[0].attempts ?? 0).toBe(0)
    for (let i = 0; i < MAX_ATTEMPTS; i++) await f.engine.flushNow()
    expect(f.engine.deadLettered()).toHaveLength(1)
    expect(f.engine.outbox.all()[0].attempts).toBe(5)
    expect(captured(f.engine.outbox.all()[0])).toEqual(captured(f.original))
    expect(f.engine.outbox.all()[0].lastError).toBe(refundPermissionError)
    // lastError follows existing retry semantics; it is not a full error journal.
    expect(resolving()).toEqual([])
    expect(f.delivery.mutationCalls).toBe(1)
    expect(f.reconstruct().outbox.all()).toEqual(f.engine.outbox.all())
  })

  it('acknowledges independent mixed-batch successes while retaining the denied original refund', async () => {
    const f = refundPermissionFixture()
    await f.engine.outbox.add('customer_create', 'independent-customer', { name: 'Synthetic' })
    const result = await f.engine.flush()
    expect(result?.processed).toBe(1)
    expect(result?.results.map(({ idempotencyKey, status }) => ({ idempotencyKey, status }))).toEqual([
      { idempotencyKey: f.original.idempotencyKey, status: 'error' },
      { idempotencyKey: 'independent-customer', status: 'ok' },
    ])
    expect(f.engine.outbox.all()).toHaveLength(1)
    expect(captured(f.engine.outbox.all()[0])).toEqual(captured(f.original))
    expect(f.engine.pendingCount()).toBe(1)
    expect(f.delivery.mutationCalls).toBe(0)
  })
})
