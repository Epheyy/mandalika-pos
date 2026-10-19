import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type ApiLike } from './engine'
import { RECEIPT_ARCHIVE_KEY, type ReceiptEntry } from './receiptArchive'
import { MAX_ATTEMPTS, type OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

// A41: a refund may name its sale by the client orderUuid (saleOrderUuid). The engine sends it only once the
// sale is acknowledged, holds it (and any later shift open/close) while the sale is queued, and parks it
// for review when the sale itself is parked. Nothing is ever deleted and the payload is never rewritten.

const OUTBOX_KEY = 'mandalika.pos.outbox'
const NOW = '2026-10-20T03:00:00.000Z'

interface Sent { type: string; idempotencyKey: string; payload: Record<string, unknown> }
type Reply = (it: Sent) => Record<string, unknown>

function fakeApi(reply: Reply = (it) => ({ status: 'ok', orderId: `srv-${it.type}-${it.idempotencyKey}` })) {
  const calls: Sent[][] = []
  const request = vi.fn(async (_m: string, _p: string, body: { items: Sent[] }) => {
    calls.push(body.items)
    return { data: { processed: body.items.length, version: 0, results: body.items.map((i) => ({ idempotencyKey: i.idempotencyKey, ...reply(i) })) } }
  })
  const api: ApiLike = { request: request as unknown as ApiLike['request'] }
  return { api, calls, types: () => calls.map((c) => c.map((i) => i.type)) }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const online = () => vi.stubGlobal('navigator', { onLine: true })
const actor = (outletId = 'out1') => () => ({ userId: 'u1', outletId, shiftId: null })
const engineOf = (api: ApiLike, kv = controllableKV().kv, outletId = 'out1') =>
  new SyncEngine(api, {}, kv, { actor: actor(outletId) })
const sale = (n: number) => ({
  orderNumber: `ORD-${n}`, paymentMethod: 'cash', quotedTotal: 1000 * n, total: 1000 * n,
  customerId: 'cust-1', customerName: 'Budi', notes: 'rahasia', receiptSnapshot: { total: 1000 * n },
})
const refundOf = (saleOrderUuid: string, extra: Record<string, unknown> = {}) => ({ orderId: '', saleOrderUuid, reason: 'salah', ...extra })
const rows = (store: Map<string, string>): OutboxItem[] => JSON.parse(store.get(OUTBOX_KEY) ?? '[]')

describe('linked refund send rule', () => {
  it('sends the sale first and the refund in a follow-up request of the same flush', async () => {
    const { api, types } = fakeApi()
    const e = engineOf(api)
    const { orderUuid } = await e.enqueue('order', sale(1))
    await e.enqueue('refund', refundOf(orderUuid))
    online()
    await e.flushNow()
    expect(types()).toEqual([['order'], ['refund']])
    await e.idle()
    expect(e.queuedRefunds()).toEqual([])
  })

  it('sends the refund payload exactly as captured (A11 fingerprint)', async () => {
    const { api, calls } = fakeApi()
    const kv = controllableKV()
    const e = engineOf(api, kv.kv)
    const { orderUuid } = await e.enqueue('order', sale(1))
    await e.enqueue('refund', refundOf(orderUuid))
    const stored = rows(kv.store).find((r) => r.type === 'refund')!.payload
    online()
    await e.flushNow()
    expect(calls.flat().find((i) => i.type === 'refund')!.payload).toEqual(stored)
  })

  it('holds the refund and every later shift open/close while the sale is still queued', async () => {
    const { api, types } = fakeApi((it) =>
      it.type === 'order' ? { status: 'error', error: 'busy', code: 'busy', retryable: true } : { status: 'ok' })
    const kv = controllableKV()
    const e = engineOf(api, kv.kv)
    const { orderUuid } = await e.enqueue('order', sale(1))
    await e.enqueue('refund', refundOf(orderUuid))
    await e.enqueue('shift_close', { shiftId: 's1', closingCash: 0 })
    online()
    await e.flushNow()
    expect(types()).toEqual([['order']])
    expect(rows(kv.store).map((r) => [r.type, r.status === 'acked'])).toEqual([['order', false], ['refund', false], ['shift_close', false]])
  })

  it('a shift close queued BEFORE the held refund is not held', async () => {
    const { api, types } = fakeApi((it) =>
      it.type === 'order' ? { status: 'error', error: 'busy', code: 'busy', retryable: true } : { status: 'ok' })
    const e = engineOf(api)
    await e.enqueue('shift_close', { shiftId: 's0', closingCash: 0 })
    const { orderUuid } = await e.enqueue('order', sale(1))
    await e.enqueue('refund', refundOf(orderUuid))
    online()
    await e.flushNow()
    // The order's retryable failure holds later shift ops in the same request, but the close sits ahead of it.
    expect(types()[0]).toEqual(['shift_close', 'order'])
  })

  it('sends at once when the sale is already acknowledged and archived', async () => {
    const entry: ReceiptEntry = {
      orderUuid: 'sale-1', idempotencyKey: 'dev:sale-1', orderNumber: 'O1', capturedAt: NOW, outletId: 'out1', shiftId: null,
      paymentMethod: 'cash', quotedTotal: 1, receiptSnapshot: null, archivedAt: Date.parse(NOW), serverOrderId: 'srv-1',
    }
    const { api, types, calls } = fakeApi()
    const e = engineOf(api, controllableKV({ [RECEIPT_ARCHIVE_KEY]: JSON.stringify([entry]) }).kv)
    await e.enqueue('refund', refundOf('sale-1', { orderId: 'srv-1' }))
    online()
    await e.flushNow()
    expect(types()).toEqual([['refund']])
    expect(calls[0][0].payload).toMatchObject({ orderId: 'srv-1', saleOrderUuid: 'sale-1' })
  })

  it('sends a refund whose sale is unknown here (the server decides)', async () => {
    const { api, types } = fakeApi()
    const e = engineOf(api)
    await e.enqueue('refund', refundOf('never-seen'))
    online()
    await e.flushNow()
    expect(types()).toEqual([['refund']])
  })

  it('leaves a refund without saleOrderUuid exactly as before', async () => {
    const { api, types } = fakeApi()
    const e = engineOf(api)
    await e.enqueue('refund', { orderId: 'srv-9', reason: 'rusak' })
    online()
    await e.flushNow()
    expect(types()).toEqual([['refund']])
  })

  describe('sale parked for review', () => {
    const parkedSale = (n: number): OutboxItem => ({
      idempotencyKey: `dev:p${n}`, type: 'order', seq: n, status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'conflict',
      reviewReason: 'x', lastError: 'x', clientCreatedAt: NOW,
      envelope: { v: 1, outletId: 'out1', userId: 'u1', deviceId: 'dev', capturedAt: NOW },
      payload: { ...sale(n), orderUuid: `p${n}`, orderNumber: `ORD-${n}`, deviceId: 'dev' },
    })

    it('parks the refund too (sale_in_review), never sends or deletes it, and does not block a shift close', async () => {
      const kv = controllableKV({ [OUTBOX_KEY]: JSON.stringify([parkedSale(1)]) })
      const { api, types } = fakeApi()
      const e = engineOf(api, kv.kv)
      await e.enqueue('refund', refundOf('p1'))
      await e.enqueue('shift_close', { shiftId: 's1', closingCash: 0 })
      online()
      await e.flushNow()
      expect(types()).toEqual([['shift_close']])
      const refund = rows(kv.store).find((r) => r.type === 'refund')!
      expect(refund).toMatchObject({ status: 'failed', reviewCode: 'sale_in_review' })
      expect(refund.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS)
      expect(refund.reviewReason).toMatch(/jangan bayar ulang/i)
      expect(e.queuedRefunds()).toMatchObject([{ parked: true }])
      expect(rows(kv.store).some((r) => r.idempotencyKey === 'dev:p1')).toBe(true)
    })
  })
})

describe('queued and acknowledged refund memory', () => {
  it('queuedRefundSaleUuids lists unacknowledged refunds (parked included) and queuedRefundOrderIds ignores the empty id', async () => {
    const { api } = fakeApi()
    const e = engineOf(api)
    await e.enqueue('refund', refundOf('sale-a'))
    await e.enqueue('refund', { orderId: 'srv-2', reason: 'r' })
    expect([...e.queuedRefundSaleUuids()]).toEqual(['sale-a'])
    expect([...e.queuedRefundOrderIds()]).toEqual(['srv-2'])
  })

  it('records the sale uuid and the server id of an acknowledged linked refund', async () => {
    const { api } = fakeApi((it) => ({ status: 'ok', orderId: it.type === 'refund' ? 'srv-resolved' : 'srv-sale' }))
    const e = engineOf(api)
    const { orderUuid } = await e.enqueue('order', sale(1))
    await e.enqueue('refund', refundOf(orderUuid))
    online()
    await e.flushNow()
    await e.idle()
    const memory = e.syncedRefundOrderIds()
    expect(memory.has(orderUuid)).toBe(true)
    expect(memory.has('srv-resolved')).toBe(true)
    expect(memory.has('')).toBe(false)
    expect(e.queuedRefundSaleUuids().size).toBe(0)
  })

  it('records the payload order id too when both ids were sent', async () => {
    const { api } = fakeApi((it) => ({ status: 'ok', orderId: it.type === 'refund' ? 'srv-1' : 'x' }))
    const e = engineOf(api)
    await e.enqueue('refund', refundOf('sale-1', { orderId: 'srv-1' }))
    online()
    await e.flushNow()
    expect([...e.syncedRefundOrderIds()].sort()).toEqual(['sale-1', 'srv-1'])
  })
})

describe('localReceipts() view', () => {
  const pendingSale = (e: SyncEngine, n: number) => e.enqueue('order', sale(n))

  it('lists queued sales and archived receipts, newest first, without customer data', async () => {
    const { api } = fakeApi()
    const e = engineOf(api)
    const a = await pendingSale(e, 1)
    online()
    await e.flushNow()
    await e.idle()
    offline()
    const b = await pendingSale(e, 2)
    const view = e.localReceipts()
    expect(view.map((r) => [r.orderUuid, r.state])).toEqual([[b.orderUuid, 'queued'], [a.orderUuid, 'synced']])
    expect(view[0]).toMatchObject({ orderNumber: 'ORD-2', paymentMethod: 'cash', quotedTotal: 2000 })
    expect(view[1].serverOrderId).toContain('srv-')
    expect(JSON.stringify(view)).not.toMatch(/Budi|cust-1|rahasia/)
  })

  it('marks parked sales and flags queued and completed refunds', async () => {
    const parked: OutboxItem = {
      idempotencyKey: 'dev:p1', type: 'order', seq: 1, status: 'failed', attempts: MAX_ATTEMPTS, reviewCode: 'conflict', reviewReason: 'x',
      clientCreatedAt: NOW, envelope: { v: 1, outletId: 'out1', userId: 'u1', deviceId: 'dev', capturedAt: NOW },
      payload: { ...sale(9), orderUuid: 'p1', orderNumber: 'ORD-P' },
    }
    const { api } = fakeApi()
    const e = engineOf(api, controllableKV({ [OUTBOX_KEY]: JSON.stringify([parked]) }).kv)
    const sold = await pendingSale(e, 3)
    await e.enqueue('refund', refundOf(sold.orderUuid))
    const view = e.localReceipts()
    expect(view.find((r) => r.orderUuid === 'p1')).toMatchObject({ state: 'parked', refundQueued: false, refunded: false })
    expect(view.find((r) => r.orderUuid === sold.orderUuid)).toMatchObject({ state: 'queued', refundQueued: true, refunded: false })
    online()
    await e.flushNow()
    await e.idle()
    expect(e.localReceipts().find((r) => r.orderUuid === sold.orderUuid)).toMatchObject({ state: 'synced', refundQueued: false, refunded: true })
  })

  it('is scoped to the terminal outlet (items without an outlet stay in scope)', async () => {
    const mk = (n: number, outletId?: string): OutboxItem => ({
      idempotencyKey: `dev:o${n}`, type: 'order', seq: n, status: 'pending', clientCreatedAt: NOW,
      ...(outletId ? { envelope: { v: 1, outletId, userId: 'u1', deviceId: 'dev', capturedAt: NOW } } : {}),
      payload: { ...sale(n), orderUuid: `o${n}`, orderNumber: `N${n}` },
    })
    const archived: ReceiptEntry[] = [
      { orderUuid: 'a-mine', idempotencyKey: 'dev:a1', orderNumber: 'A1', capturedAt: NOW, outletId: 'out1', shiftId: null, paymentMethod: 'cash', quotedTotal: 1, receiptSnapshot: null, archivedAt: 1 },
      { orderUuid: 'a-other', idempotencyKey: 'dev:a2', orderNumber: 'A2', capturedAt: NOW, outletId: 'out2', shiftId: null, paymentMethod: 'cash', quotedTotal: 1, receiptSnapshot: null, archivedAt: 1 },
    ]
    const kv = controllableKV({ [OUTBOX_KEY]: JSON.stringify([mk(1, 'out1'), mk(2, 'out2'), mk(3)]), [RECEIPT_ARCHIVE_KEY]: JSON.stringify(archived) })
    const e = engineOf(fakeApi().api, kv.kv)
    expect(e.localReceipts().map((r) => r.orderUuid).sort()).toEqual(['a-mine', 'o1', 'o3'])
  })

  it('still lists a sale whose archive write failed (the acked row is its only copy)', async () => {
    const { api } = fakeApi()
    const kv = controllableKV()
    kv.ctl.modeFor = (k) => (k === RECEIPT_ARCHIVE_KEY ? 'reject' : undefined)
    const e = engineOf(api, kv.kv)
    const sold = await pendingSale(e, 1)
    online()
    await e.flushNow()
    expect(JSON.parse(kv.store.get(RECEIPT_ARCHIVE_KEY) ?? '[]')).toEqual([])
    expect(e.localReceipts().map((r) => [r.orderUuid, r.state, r.serverOrderId?.startsWith('srv-')])).toEqual([[sold.orderUuid, 'synced', true]])
  })

  it('lists a sale only once while its acked row has not been pruned yet', async () => {
    const entry: ReceiptEntry = {
      orderUuid: 'dup', idempotencyKey: 'dev:dup', orderNumber: 'D', capturedAt: NOW, outletId: 'out1', shiftId: null,
      paymentMethod: 'cash', quotedTotal: 1, receiptSnapshot: null, archivedAt: 1,
    }
    const ackedRow: OutboxItem = {
      idempotencyKey: 'dev:dup', type: 'order', seq: 1, status: 'acked', clientCreatedAt: NOW,
      payload: { ...sale(1), orderUuid: 'dup', orderNumber: 'D' },
    }
    const kv = controllableKV({ [OUTBOX_KEY]: JSON.stringify([ackedRow]), [RECEIPT_ARCHIVE_KEY]: JSON.stringify([entry]) })
    const e = engineOf(fakeApi().api, kv.kv)
    expect(e.localReceipts().map((r) => r.orderUuid)).toEqual(['dup'])
  })
})

const offline = () => vi.stubGlobal('navigator', { onLine: false })
