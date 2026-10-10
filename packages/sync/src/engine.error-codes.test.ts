import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from './engine'
import { MAX_ATTEMPTS } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { vi.unstubAllGlobals() })

type Result = { status: 'error'; error: string; code?: string; retryable?: boolean }

async function setup(result: Result, type: 'transfer_receive' | 'order' = 'transfer_receive') {
  const { kv } = controllableKV()
  const onReceiveRejected = vi.fn()
  const request = vi.fn()
  const engine = new SyncEngine({ request }, { onReceiveRejected }, kv)
  request.mockImplementation(async (_m: string, _p: string, body: { items: { idempotencyKey: string }[] }) => ({
    data: {
      processed: 0, version: 0,
      results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, ...result })),
    },
  }))
  vi.stubGlobal('navigator', { onLine: false }) // enqueue must not auto-flush
  if (type === 'transfer_receive') {
    await engine.enqueueTransferReceive({
      transferId: 't1', approverUserId: 'u1', pin: '1234',
      items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }],
    })
  } else {
    await engine.enqueue('order', { total: 1 })
  }
  vi.stubGlobal('navigator', { onLine: true })
  await engine.flush()
  return { engine, onReceiveRejected }
}

describe('transfer_receive error codes', () => {
  it.each(['competing_receipt', 'conflict', 'not_found'])('%s goes to review: credit rolled back, counts kept, nothing deleted', async (code) => {
    const { engine, onReceiveRejected } = await setup({ status: 'error', error: 'x', code, retryable: false })
    expect(engine.outbox.all()).toHaveLength(1)
    expect(engine.outbox.all()[0]).toMatchObject({
      status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: code, reviewReason: 'x',
      payload: { items: [{ productId: 'p1', variantSize: '10ml', receivedQty: 5 }] },
    })
    expect(engine.pending.list()).toEqual([])
    expect(engine.reviewItems()).toHaveLength(1)
    expect(onReceiveRejected).toHaveBeenCalledTimes(1)
    expect(onReceiveRejected.mock.calls[0][0]).toContain('perlu ditinjau')
  })

  it('a missing code keeps the old behaviour (discard + rollback)', async () => {
    const { engine, onReceiveRejected } = await setup({ status: 'error', error: 'x' })
    expect(engine.outbox.all()).toEqual([])
    expect(engine.pending.list()).toEqual([])
    expect(onReceiveRejected).toHaveBeenCalledTimes(1)
  })

  it.each([['busy', true], ['internal', true]] as const)(
    '%s (retryable) keeps the item and the credit as a normal failure',
    async (code, retryable) => {
      const { engine, onReceiveRejected } = await setup({ status: 'error', error: 'x', code, retryable })
      expect(engine.outbox.all()).toHaveLength(1)
      expect(engine.outbox.all()[0].status).toBe('failed')
      expect(engine.outbox.all()[0].lastError).toBe('x')
      expect(engine.outbox.all()[0].attempts ?? 0).toBe(0)
      expect(engine.pending.list()).toHaveLength(1)
      expect(onReceiveRejected).not.toHaveBeenCalled()
    },
  )

  it.each(['forbidden', 'rejected', 'key_conflict'])(
    '%s (non-retryable) goes to review without the cancelled-receipt toast',
    async (code) => {
      const { engine, onReceiveRejected } = await setup({ status: 'error', error: 'x', code, retryable: false })
      expect(engine.outbox.all()[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: code })
      expect(onReceiveRejected).not.toHaveBeenCalled()
    },
  )

  it('an unknown future code keeps the attempt counting, not a discard', async () => {
    const { engine } = await setup({ status: 'error', error: 'x', code: 'brand_new', retryable: false })
    expect(engine.outbox.all()).toHaveLength(1)
    expect(engine.outbox.all()[0].attempts).toBe(1)
    expect(engine.outbox.all()[0].reviewCode).toBeUndefined()
    expect(engine.pending.list()).toHaveLength(1)
  })
})

describe('retryable results and attempts', () => {
  it('retryable=true records the error but does not count an attempt', async () => {
    const { engine } = await setup({ status: 'error', error: 'lock clash', code: 'busy', retryable: true }, 'order')
    const item = engine.outbox.all()[0]
    expect(item.lastError).toBe('lock clash')
    expect(item.attempts ?? 0).toBe(0)
    expect(engine.pendingCount()).toBe(1) // still retried on the normal poll
  })

  it('retryable=true never parks, however many times it repeats', async () => {
    const { engine } = await setup({ status: 'error', error: 'e', code: 'internal', retryable: true }, 'order')
    for (let i = 0; i < 8; i++) await engine.flush()
    expect(engine.outbox.all()[0].attempts ?? 0).toBe(0)
    expect(engine.deadLettered()).toEqual([])
  })

  it('retryable=false with a known code goes straight to review (no 5-attempt wait)', async () => {
    const { engine } = await setup({ status: 'error', error: 'e', code: 'rejected', retryable: false }, 'order')
    expect(engine.outbox.all()[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'rejected', reviewReason: 'e' })
    expect(engine.deadLettered()).toHaveLength(1)
    expect(engine.pendingCount()).toBe(0)
  })

  it('retryable=false with an unknown code keeps counting attempts and parks at the cap', async () => {
    const { engine } = await setup({ status: 'error', error: 'e', code: 'brand_new', retryable: false }, 'order')
    expect(engine.outbox.all()[0].attempts).toBe(1)
    for (let i = 0; i < 4; i++) await engine.flush()
    expect(engine.deadLettered()).toHaveLength(1)
    expect(engine.outbox.all()[0].reviewCode).toBeUndefined()
  })

  it('a missing code and retryable field counts an attempt (older server) and parks at the cap', async () => {
    const { engine } = await setup({ status: 'error', error: 'e' }, 'order')
    expect(engine.outbox.all()[0].attempts).toBe(1)
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await engine.flush()
    expect(engine.outbox.all()[0].attempts).toBe(MAX_ATTEMPTS)
    expect(engine.reviewItems()).toHaveLength(1) // shown as review, reviewCode unset
    expect(engine.reviewItems()[0].reviewCode).toBeUndefined()
  })
})
