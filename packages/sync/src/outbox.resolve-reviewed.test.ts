import { describe, expect, it } from 'vitest'
import { MAX_ATTEMPTS, Outbox } from './outbox'
import { KVOutboxStore } from './outboxStore'
import { controllableKV } from './testFixtures/controllableKV'

async function setup() {
  const { kv, ctl } = controllableKV()
  const outbox = new Outbox(new KVOutboxStore(kv))
  await outbox.add('refund', 'dev:parked', { orderNumber: 'BSD-G0007' })
  await outbox.add('order', 'dev:pending', { total: 1 })
  await outbox.add('order', 'dev:old-park', { total: 2 })
  await outbox.settle([{ key: 'dev:parked', op: 'review', code: 'forbidden', reason: 'denied' }])
  // Legacy park by attempt counting: failed with attempts >= MAX_ATTEMPTS, no code.
  // One rejection per settle (a batch counts one attempt per key).
  for (let n = 0; n < MAX_ATTEMPTS; n++) {
    await outbox.settle([{ key: 'dev:old-park', op: 'fail', error: 'x' }])
  }
  return { outbox, ctl }
}

describe('Outbox.resolveReviewed', () => {
  it('removes parked items (coded and legacy) and returns them', async () => {
    const { outbox } = await setup()
    const removed = await outbox.resolveReviewed(['dev:parked', 'dev:old-park'])
    expect(removed.map((i) => i.idempotencyKey).sort()).toEqual(['dev:old-park', 'dev:parked'])
    expect(outbox.reviewItems()).toEqual([])
    expect(outbox.pending().map((i) => i.idempotencyKey)).toEqual(['dev:pending'])
  })

  it('never removes a pending, unknown or re-queued item', async () => {
    const { outbox } = await setup()
    await outbox.retryDeadLettered((i) => i.idempotencyKey === 'dev:parked') // cashier pressed "Coba lagi"
    const removed = await outbox.resolveReviewed(['dev:parked', 'dev:pending', 'dev:unknown'])
    expect(removed).toEqual([])
    expect(outbox.pending().map((i) => i.idempotencyKey).sort()).toEqual(['dev:parked', 'dev:pending'])
  })

  it('rejects and keeps the queue when the durable write fails', async () => {
    const { outbox, ctl } = await setup()
    ctl.mode = 'reject'
    await expect(outbox.resolveReviewed(['dev:parked'])).rejects.toThrow()
    ctl.mode = 'ok'
    expect(outbox.reviewItems().map((i) => i.idempotencyKey)).toContain('dev:parked')
  })

  it('exposes the capture outlet on review items when the item has an envelope', async () => {
    const { kv } = controllableKV()
    const outbox = new Outbox(new KVOutboxStore(kv))
    const envelope = { v: 1, outletId: 'outlet-a', userId: 'u1', deviceId: 'dev', capturedAt: '2026-10-12T03:00:00Z' }
    await outbox.add('refund', 'dev:env', { orderNumber: 'X' }, envelope)
    await outbox.settle([{ key: 'dev:env', op: 'review', code: 'forbidden', reason: 'denied' }])
    expect(outbox.reviewItems()[0].capturedOutletId).toBe('outlet-a')
  })
})
