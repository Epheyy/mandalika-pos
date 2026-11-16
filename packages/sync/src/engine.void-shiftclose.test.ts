import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ActorContext, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// Void vs shift_close ordering: a void queued before the shift's close must reach the server before it, also when the
// void waits behind its unacked sale. A PARKED void is a different case (see the last test): it does not hold the close,
// so the POS blocks Tutup Shift itself while a void is stuck (apps/pos voidsBlockingShiftClose).

type Body = { items: { type: string; idempotencyKey: string; payload: Record<string, unknown> }[] }
const api = (request: unknown): ApiLike => ({ request: request as ApiLike['request'] })
const actor = (): ActorContext => ({ outletId: 'outlet-a', userId: 'user-a', shiftId: 'shift-1' })

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false }) // enqueue must not auto-flush
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const online = () => vi.stubGlobal('navigator', { onLine: true })

function make(request: unknown) {
  const { kv } = controllableKV()
  return new SyncEngine(api(request), {}, kv, { actor, ...({} as object) } as ConstructorParameters<typeof SyncEngine>[3])
}

const reply = (verdict: (i: Body['items'][number]) => Record<string, unknown>) =>
  vi.fn(async (_m: string, _p: string, body: Body) => ({
    data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, orderId: `srv-${i.idempotencyKey}`, ...verdict(i) })) },
  }))
const ok = () => reply(() => ({ status: 'ok' }))
const sentTypes = (r: ReturnType<typeof reply>) => r.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))

const SALE_UUID = 'sale-uuid-1'
const SALE = { orderUuid: SALE_UUID, orderNumber: 'BSD-0001', paymentMethod: 'cash', quotedTotal: 100000, total: 100000, items: [{ productId: 'p1', variantSize: '30ml', quantity: 1 }] }
const voidPayload = (over: Record<string, unknown> = {}) => ({
  reasonCode: 'salah_barang', mode: 'none', orderNumber: 'BSD-0001', total: 100000,
  restockLines: [{ productId: 'p1', variantSize: '30ml', quantity: 1 }],
  originalShiftId: 'shift-1', originalTenders: [{ method: 'cash', amount: 100000 }], ...over,
})
const CLOSE = { shiftId: 'shift-1', closingCash: 100000 }

describe('void before shift_close', () => {
  it('a void queued before shift_close is sent before it', async () => {
    const request = ok()
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    await engine.enqueue('shift_close', CLOSE)
    online()
    await engine.flushNow()
    expect(sentTypes(request)).toEqual(['void', 'shift_close'])
  })

  it('a void held behind its unacked sale also holds a later shift_close', async () => {
    const request = reply(() => ({ status: 'error', error: 'busy', code: 'busy', retryable: true }))
    const engine = make(request)
    const { orderUuid } = await engine.enqueue('order', SALE, SALE_UUID)
    await engine.enqueue('void', voidPayload({ saleOrderUuid: orderUuid }))
    await engine.enqueue('shift_close', CLOSE)
    online()
    await engine.flushNow()
    expect(sentTypes(request)).toEqual(['order']) // neither the void nor the close went out
    expect(engine.pendingShiftOps().filter((o) => o.type === 'shift_close' && !o.parked)).toHaveLength(1)
  })

  it('once the sale acks in the same flush, the held void goes out and the close follows it', async () => {
    const request = ok()
    const engine = make(request)
    const { orderUuid } = await engine.enqueue('order', SALE, SALE_UUID)
    await engine.enqueue('void', voidPayload({ saleOrderUuid: orderUuid }))
    await engine.enqueue('shift_close', CLOSE)
    online()
    await engine.flushNow()
    expect(sentTypes(request)).toEqual(['order', 'void', 'shift_close'])
  })

  it('a PARKED void does not hold a later shift_close (the POS blocks Tutup Shift instead)', async () => {
    const refuse = reply((i) => (i.type === 'void' ? { status: 'error', error: 'x', code: 'forbidden', retryable: false } : { status: 'ok' }))
    const engine = make(refuse)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    online()
    await engine.flushNow()
    expect(engine.queuedVoids().map((v) => v.parked)).toEqual([true])
    refuse.mockClear()
    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('shift_close', CLOSE)
    online()
    await engine.flushNow()
    expect(sentTypes(refuse)).toEqual(['shift_close'])
  })
})
