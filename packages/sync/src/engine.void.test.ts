import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canVoidAny, canVoidOwnShift } from '@mandalika/types'
import { SyncEngine, type ActorContext, type ApiLike } from './engine'
import { controllableKV } from './testFixtures/controllableKV'

// Phase 3 (void): the `void` outbox type. A void names its sale by uuid and, while that sale is still queued, is
// held behind it exactly like a refund; its stock effect and its replacement receipt are visible locally until acked.

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

function make(request: unknown = vi.fn()) {
  const { kv } = controllableKV()
  return new SyncEngine(api(request), {}, kv, { actor, ...({} as object) } as ConstructorParameters<typeof SyncEngine>[3])
}

const okAll = (extra: (i: Body['items'][number]) => Record<string, unknown> = () => ({})) =>
  vi.fn(async (_m: string, _p: string, body: Body) => ({
    data: {
      processed: body.items.length, version: 0,
      results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'ok', orderId: `srv-${i.idempotencyKey}`, ...extra(i) })),
    },
  }))

const SALE_UUID = 'sale-uuid-1'
const SALE = {
  orderUuid: SALE_UUID, orderNumber: 'BSD-0001', paymentMethod: 'cash', quotedTotal: 100000, total: 100000, items: [{ productId: 'p1', variantSize: '30ml', quantity: 1 }] }
const voidPayload = (over: Record<string, unknown> = {}) => ({
  reasonCode: 'salah_barang', mode: 'none', orderNumber: 'BSD-0001', total: 100000,
  restockLines: [{ productId: 'p1', variantSize: '30ml', quantity: 2 }],
  originalShiftId: 'shift-1', originalTenders: [{ method: 'cash', amount: 100000 }],
  ...over,
})
const REPLACEMENT = {
  orderUuid: 'rep-uuid', orderNumber: 'BSD-0009', paymentMethod: 'qris', quotedTotal: 90000, receiptSnapshot: { total: 90000 },
  items: [{ productId: 'p2', variantSize: '10ml', quantity: 3 }],
  tenders: [{ method: 'qris', amount: 90000 }],
}

describe('canVoidOwnShift / canVoidAny', () => {
  it('canVoidOwnShift is true for admin and for void_own_shift, false otherwise', () => {
    expect(canVoidOwnShift({ role: 'admin' })).toBe(true)
    expect(canVoidOwnShift({ role: 'cashier', permissions: ['void_own_shift'] })).toBe(true)
    expect(canVoidOwnShift({ role: 'cashier', permissions: ['void_any'] })).toBe(false)
    expect(canVoidOwnShift({ role: 'cashier', permissions: [] })).toBe(false)
    expect(canVoidOwnShift({ role: 'cashier' })).toBe(false)
    expect(canVoidOwnShift(null)).toBe(false)
    expect(canVoidOwnShift(undefined)).toBe(false)
  })

  it('canVoidAny is true for admin and for void_any, false otherwise', () => {
    expect(canVoidAny({ role: 'admin' })).toBe(true)
    expect(canVoidAny({ role: 'cashier', permissions: ['void_any'] })).toBe(true)
    expect(canVoidAny({ role: 'cashier', permissions: ['void_own_shift', 'process_refund'] })).toBe(false)
    expect(canVoidAny(null)).toBe(false)
  })
})

describe('a void of an unacked sale is held behind it', () => {
  it('a void of an unacked sale is held behind it and sent after the sale acks', async () => {
    const request = okAll()
    const engine = make(request)
    const { orderUuid } = await engine.enqueue('order', SALE, SALE_UUID)
    expect(orderUuid).toBe(SALE_UUID)
    await engine.enqueue('void', voidPayload({ saleOrderUuid: orderUuid }))
    online()
    await engine.flushNow()
    const sent = request.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))
    // sale first, the void only after the sale acked (second pass of the same flush)
    expect(sent).toEqual(['order', 'void'])
    expect(request.mock.calls).toHaveLength(2)
    expect(engine.unsettledCount()).toBe(0)
  })

  it('holds the void (and nothing else is lost) while the sale is not acked', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'busy', code: 'busy', retryable: true })),
      },
    }))
    const engine = make(request)
    const { orderUuid } = await engine.enqueue('order', SALE, SALE_UUID)
    expect(orderUuid).toBe(SALE_UUID)
    await engine.enqueue('void', voidPayload({ saleOrderUuid: orderUuid }))
    online()
    await engine.flushNow()
    const sent = request.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))
    expect(sent).toEqual(['order']) // the void never went out
    expect(engine.queuedVoids()).toHaveLength(1)
  })

  it('a void whose sale is not queued is sent normally', async () => {
    const request = okAll()
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    online()
    await engine.flushNow()
    expect(request.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))).toEqual(['void'])
  })

  it('a void whose sale is parked for review is parked too (sale_in_review), never sent', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'forbidden', retryable: false })),
      },
    }))
    const engine = make(request)
    const { orderUuid } = await engine.enqueue('order', SALE, SALE_UUID)
    expect(orderUuid).toBe(SALE_UUID)
    online()
    await engine.flushNow() // the sale is refused -> parked
    expect(engine.reviewItems().map((r) => r.type)).toEqual(['order'])
    request.mockClear()
    vi.stubGlobal('navigator', { onLine: false }) // enqueue must not auto-flush
    await engine.enqueue('void', voidPayload({ saleOrderUuid: orderUuid }))
    online()
    await engine.flushNow()
    expect(request.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))).not.toContain('void')
    const parked = engine.reviewItems().find((r) => r.type === 'void')
    expect(parked?.reviewCode).toBe('sale_in_review')
    expect(parked?.reviewReason).toMatch(/pembatalan/i)
  })
})

describe('pendingStockDeltas for voids', () => {
  it('pendingStockDeltas adds back restockLines and subtracts replacement items until acked', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    // delta convention: positive = stock the displayed number must lose
    expect(engine.pendingStockDeltas()).toEqual({ 'p1|30ml': -2, 'p2|10ml': 3 })
  })

  it('a mode none void only restocks', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    expect(engine.pendingStockDeltas()).toEqual({ 'p1|30ml': -2 })
  })

  it('an acked void with a replacement keeps the replacement debit (A15 settling) until a pull; the restock is dropped', async () => {
    const engine = make(okAll())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    online()
    await engine.flushNow()
    expect(engine.unsettledCount()).toBe(0)
    expect(engine.pendingStockDeltas()).toEqual({ 'p2|10ml': 3 })
  })

  it('an acked mode none void leaves no delta', async () => {
    const engine = make(okAll())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    online()
    await engine.flushNow()
    expect(engine.pendingStockDeltas()).toEqual({})
  })

  it('a refused (parked) void still counts', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'x', code: 'forbidden', retryable: false })),
      },
    }))
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    online()
    await engine.flushNow()
    expect(engine.reviewItems()).toHaveLength(1)
    expect(engine.pendingStockDeltas()).toEqual({ 'p1|30ml': -2 })
  })

  it('a void of another outlet (capture envelope) is out of scope', async () => {
    const { kv } = controllableKV()
    let outlet = 'outlet-a'
    const engine = new SyncEngine(api(vi.fn()), {}, kv, { actor: () => ({ outletId: outlet, userId: 'u', shiftId: null }) })
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    outlet = 'outlet-b'
    expect(engine.pendingStockDeltas()).toEqual({})
  })
})

describe('localReceipts for a void replacement', () => {
  it('localReceipts lists the replacement with replacesOrderNumber', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    const [r] = engine.localReceipts()
    expect(r).toMatchObject({
      orderUuid: 'rep-uuid', orderNumber: 'BSD-0009', replacesOrderNumber: 'BSD-0001', state: 'queued', paymentMethod: 'qris',
      quotedTotal: 90000, tenders: [{ method: 'qris', amount: 90000 }],
    })
  })

  it('a void with mode none produces no receipt', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    expect(engine.localReceipts()).toEqual([])
  })

  it('an acked void stores the replacement order id and the receipt is archived as synced', async () => {
    const request = okAll(() => ({ replacementOrderId: 'srv-replacement' }))
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    online()
    await engine.flushNow()
    expect(engine.unsettledCount()).toBe(0)
    const [r] = engine.localReceipts()
    expect(r).toMatchObject({ orderUuid: 'rep-uuid', state: 'synced', serverOrderId: 'srv-replacement', replacesOrderNumber: 'BSD-0001' })
  })

  it('a refund naming the replacement by uuid is held until the void acks', async () => {
    const request = okAll(() => ({ replacementOrderId: 'srv-replacement' }))
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    await engine.enqueue('refund', { orderId: '', saleOrderUuid: 'rep-uuid', reason: 'x', orderNumber: 'BSD-0009', total: 90000 })
    online()
    await engine.flushNow()
    const sent = request.mock.calls.flatMap((c) => (c[2] as Body).items.map((i) => i.type))
    expect(sent).toEqual(['void', 'refund'])
    expect(request.mock.calls).toHaveLength(2)
  })
})

describe('queuedVoids / queuedVoidOrderIds', () => {
  it('a parked void appears in queuedVoids with its review reason', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'Shift sudah ditutup', code: 'forbidden', retryable: false })),
      },
    }))
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: REPLACEMENT }))
    online()
    await engine.flushNow()
    const [v] = engine.queuedVoids()
    expect(v).toMatchObject({
      orderId: 'srv-1', mode: 'replace', status: 'failed', reviewReason: 'Shift sudah ditutup',
      originalShiftId: 'shift-1', originalTenders: [{ method: 'cash', amount: 100000 }],
      replacementOrderUuid: 'rep-uuid', replacementTenders: [{ method: 'qris', amount: 90000 }],
    })
    expect(typeof v?.idempotencyKey).toBe('string')
  })

  it('lists queued voids only, carries nulls for missing display facts, and drops acked ones', async () => {
    const engine = make(okAll())
    await engine.enqueue('order', { ...SALE, orderUuid: 'other' })
    await engine.enqueue('void', { reasonCode: 'lainnya', mode: 'none', orderNumber: 'X', total: 1, orderId: 'srv-9' })
    const [v] = engine.queuedVoids()
    expect(v).toMatchObject({ orderId: 'srv-9', mode: 'none', originalShiftId: null, originalTenders: [] })
    expect(v).not.toHaveProperty('replacementOrderUuid')
    online()
    await engine.flushNow()
    expect(engine.queuedVoids()).toEqual([])
  })

  it('exposes APPLIED tenders: cash change is trimmed (85k sale, 100k handed -> 85k), and the display facts', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({
      orderId: 'srv-1', mode: 'replace', total: 85000, originalTenders: [{ method: 'cash', amount: 100000 }],
      replacement: { ...REPLACEMENT, quotedTotal: 85000, receiptSnapshot: { total: 85000 }, tenders: [{ method: 'cash', amount: 100000 }] },
    }))
    const [v] = engine.queuedVoids()
    expect(v?.originalTenders).toEqual([{ method: 'cash', amount: 85000 }])
    expect(v?.replacementTenders).toEqual([{ method: 'cash', amount: 85000 }])
    expect(v).toMatchObject({ orderNumber: 'BSD-0001', reasonCode: 'salah_barang', total: 85000, replacementOrderNumber: 'BSD-0009' })
  })

  it('a locked replacement (correctionTarget original_total) is trimmed to the original total, not the cart price', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({
      orderId: 'srv-1', mode: 'replace', total: 100000,
      replacement: { ...REPLACEMENT, correctionTarget: 'original_total', quotedTotal: 90000, tenders: [{ method: 'cash', amount: 100000 }] },
    }))
    expect(engine.queuedVoids()[0]?.replacementTenders).toEqual([{ method: 'cash', amount: 100000 }])
  })

  it('queuedVoidOrderIds holds order ids and sale uuids, and resolves a synced sale id', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    await engine.enqueue('void', voidPayload({ saleOrderUuid: 'sale-uuid' }))
    await engine.enqueue('refund', { orderId: 'srv-refund', reason: 'x' })
    expect([...engine.queuedVoidOrderIds()].sort()).toEqual(['sale-uuid', 'srv-1'])
  })
})

describe('queuedReplacementOrderIds', () => {
  it('lists voided orders that have an unacknowledged replacement sale queued', async () => {
    const engine = make(vi.fn())
    await engine.enqueue('order', { ...SALE, replacesOrderId: 'srv-voided' }, 'rep-1')
    await engine.enqueue('order', SALE, 'plain-1')
    expect([...engine.queuedReplacementOrderIds()]).toEqual(['srv-voided'])
  })
})

describe('replacement stamping', () => {
  it('stamps deviceId and clientCreatedAt on the replacement, keeping values the caller set', async () => {
    const request = okAll()
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1', mode: 'replace', replacement: { ...REPLACEMENT, clientCreatedAt: '2026-01-01T00:00:00.000Z' } }))
    const [row] = engine.outbox.all()
    const rep = row?.payload.replacement as Record<string, unknown>
    expect(rep.deviceId).toBe(engine.deviceId)
    expect(rep.clientCreatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(rep.orderUuid).toBe('rep-uuid')
    const { replacement: _r, ...top } = row!.payload
    expect(top.deviceId).toBe(engine.deviceId)
    const second = await engine.enqueue('void', voidPayload({ orderId: 'srv-2', mode: 'replace', replacement: REPLACEMENT }), 'void-2')
    const r2 = engine.outbox.all().find((i) => i.idempotencyKey === second.idempotencyKey)?.payload.replacement as Record<string, unknown>
    expect(typeof r2.clientCreatedAt).toBe('string')
  })
})

describe('voided sale flags and parked voids', () => {
  it('flags the sale voidQueued while its void waits, then voided once acked', async () => {
    const engine = make(okAll())
    await engine.enqueue('order', SALE, SALE_UUID)
    online()
    await engine.flushNow()
    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('void', voidPayload({ saleOrderUuid: SALE_UUID }))
    expect(engine.localReceipts()[0]).toMatchObject({ orderUuid: SALE_UUID, voidQueued: true, voided: false })
    online()
    await engine.flushNow()
    expect(engine.localReceipts()[0]).toMatchObject({ orderUuid: SALE_UUID, voidQueued: false, voided: true })
    expect([...engine.syncedVoidOrderIds()]).toContain(SALE_UUID)
  })

  it('the voided memory survives an engine restart (durable, like synced refunds)', async () => {
    const { kv } = controllableKV()
    const mk = () => new SyncEngine(api(okAll()), {}, kv, { actor })
    const engine = mk()
    await engine.enqueue('order', SALE, SALE_UUID)
    online()
    await engine.flushNow()
    vi.stubGlobal('navigator', { onLine: false })
    await engine.enqueue('void', voidPayload({ saleOrderUuid: SALE_UUID, orderId: 'srv-sale' }))
    online()
    await engine.flushNow()
    await engine.idle()
    const restarted = mk().syncedVoidOrderIds()
    expect(restarted.has('srv-sale') && restarted.has(SALE_UUID)).toBe(true)
  })

  it('a parked void is marked parked and does not block (queuedVoidOrderIds excludes it)', async () => {
    const request = vi.fn(async (_m: string, _p: string, body: Body) => ({
      data: {
        processed: 0, version: 0,
        results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, status: 'error', error: 'ditolak', code: 'forbidden', retryable: false })),
      },
    }))
    const engine = make(request)
    await engine.enqueue('void', voidPayload({ orderId: 'srv-1' }))
    expect(engine.queuedVoids()[0]).toMatchObject({ parked: false })
    expect([...engine.queuedVoidOrderIds()]).toEqual(['srv-1'])
    online()
    await engine.flushNow()
    expect(engine.queuedVoids()[0]).toMatchObject({ parked: true, status: 'failed', reviewReason: 'ditolak' })
    expect(engine.queuedVoidOrderIds().size).toBe(0)
  })
})
