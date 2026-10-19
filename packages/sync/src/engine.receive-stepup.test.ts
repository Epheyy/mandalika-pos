import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

beforeEach(() => { vi.stubGlobal('navigator', { onLine: false }) })
afterEach(() => { vi.unstubAllGlobals() })

const items = [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }]

function make() {
  const { kv } = controllableKV()
  const request = vi.fn()
  const engine = new SyncEngine({ request }, {}, kv, { actor: () => ({ outletId: 'o1', userId: 'u1' }) })
  return { engine, request, kv }
}

// A08: the receipt key exists before the approval is requested, so a lost mint response reuses it.
describe('transfer receive step-up (engine)', () => {
  it('newReceiveKey returns a fresh uuid and the device-prefixed key the outbox will use', () => {
    const { engine } = make()
    const a = engine.newReceiveKey()
    const b = engine.newReceiveKey()
    expect(a.orderUuid).not.toBe(b.orderUuid)
    expect(a.idempotencyKey.endsWith(`:${a.orderUuid}`)).toBe(true)
  })

  it('enqueue uses the pre-created key and its payload never has a pin key', async () => {
    const { engine } = make()
    const k = engine.newReceiveKey()
    const { idempotencyKey } = await engine.enqueueTransferReceive({
      orderUuid: k.orderUuid, transferId: 't1', items, discrepancyReason: 'rusak', approvalGrantId: 'g1',
    })
    expect(idempotencyKey).toBe(k.idempotencyKey)
    const row = engine.outbox.all()[0]
    expect(row.idempotencyKey).toBe(k.idempotencyKey)
    expect(row.payload).toMatchObject({ transferId: 't1', approvalGrantId: 'g1', discrepancyReason: 'rusak', items })
    expect(row.payload).not.toHaveProperty('pin')
    expect(JSON.stringify(row)).not.toMatch(/"pin"/)
    expect(engine.pending.list()).toHaveLength(1) // optimistic credit kept
  })

  it('requestReceiveApproval posts the receipt key and PIN to the mint endpoint and returns the grant', async () => {
    const { engine, request } = make()
    request.mockResolvedValue({ data: { approvalGrantId: 'g1', expiresAt: 'x', approverUserId: 'a1', approverName: 'Admin' } })
    const k = engine.newReceiveKey()
    const grant = await engine.requestReceiveApproval({
      idempotencyKey: k.idempotencyKey, transferId: 't1', items, discrepancyReason: '', approverUserId: 'a1', pin: '4321',
    })
    expect(grant.approvalGrantId).toBe('g1')
    const [method, path, body] = request.mock.calls[0]
    expect(method).toBe('POST')
    expect(path).toBe('/api/v1/sync/transfer-receive-approvals')
    expect(body).toMatchObject({ transferId: 't1', idempotencyKey: k.idempotencyKey, approverUserId: 'a1', pin: '4321', items })
    expect(typeof body.deviceId).toBe('string')
    expect(engine.outbox.all()).toEqual([]) // nothing queued until the caller enqueues
  })

  it('listReceiveApprovers reads the online list', async () => {
    const { engine, request } = make()
    request.mockResolvedValue({ data: [{ userId: 'a1', displayName: 'Admin' }] })
    expect(await engine.listReceiveApprovers()).toEqual([{ userId: 'a1', displayName: 'Admin' }])
    expect(request.mock.calls[0].slice(0, 2)).toEqual(['GET', '/api/v1/sync/receive-approvers'])
  })

  it('start() scrubs a legacy PIN from queued transfer_receive rows, once', async () => {
    const { engine } = make()
    await engine.outbox.add('transfer_receive', 'd:legacy', { transferId: 't1', pin: '1234' })
    const stop = engine.start()
    await engine.outbox.idle()
    stop()
    expect(engine.outbox.all()[0].payload).not.toHaveProperty('pin')
  })
})
