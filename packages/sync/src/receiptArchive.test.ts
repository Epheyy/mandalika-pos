import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReceiptArchive,
  RECEIPT_ARCHIVE_KEY,
  RECEIPT_KEEP_NEWEST,
  RECEIPT_RETENTION_MS,
  prunable,
  receiptEntryFromItem,
  type ReceiptEntry,
  type ReceiptContext,
} from './receiptArchive'
import type { OutboxItem } from './outbox'
import { controllableKV } from './testFixtures/controllableKV'

const NOW = Date.parse('2026-10-20T03:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function entry(n: number, ageMs: number, extra: Partial<ReceiptEntry> = {}): ReceiptEntry {
  return {
    orderUuid: `u${n}`, idempotencyKey: `dev:u${n}`, orderNumber: `N${n}`, capturedAt: iso(NOW - ageMs),
    outletId: 'out1', shiftId: null, paymentMethod: 'cash', quotedTotal: 1000, receiptSnapshot: { total: 1000 },
    archivedAt: NOW, ...extra,
  }
}
const noCtx: ReceiptContext = { unsynced: [], referenced: new Set() }

describe('retention: 7 days OR newest 500', () => {
  it('keeps a receipt younger than 7 days even beyond the 500th', () => {
    const entries = Array.from({ length: RECEIPT_KEEP_NEWEST + 1 }, (_, i) => entry(i, DAY + i))
    expect(prunable(entries, noCtx, NOW).size).toBe(0)
  })

  it('keeps the 500th and prunes the 501st only when both are older than 7 days', () => {
    const old = RECEIPT_RETENTION_MS + DAY
    const entries = Array.from({ length: RECEIPT_KEEP_NEWEST + 1 }, (_, i) => entry(i, old + i * 1000))
    // u0 is the newest ... u500 is the 501st.
    expect([...prunable(entries, noCtx, NOW)]).toEqual(['u500'])
  })

  it('treats exactly 7 days as still kept (older than, not at)', () => {
    const entries = Array.from({ length: RECEIPT_KEEP_NEWEST + 1 }, (_, i) => entry(i, i === RECEIPT_KEEP_NEWEST ? RECEIPT_RETENTION_MS : DAY))
    expect(prunable(entries, noCtx, NOW).size).toBe(0)
  })

  it('a forward-running device clock still keeps the newest 500', () => {
    // The clock says it is a year later: everything is older than 7 days, the 500 floor holds.
    const later = NOW + 365 * DAY
    const entries = Array.from({ length: RECEIPT_KEEP_NEWEST + 3 }, (_, i) => entry(i, DAY + i * 1000))
    const dropped = prunable(entries, noCtx, later)
    expect(dropped.size).toBe(3)
    for (let i = 0; i < RECEIPT_KEEP_NEWEST; i++) expect(dropped.has(`u${i}`)).toBe(false)
  })

  it('counts unsynced sales toward the newest 500, so they push old archived receipts out', () => {
    const old = RECEIPT_RETENTION_MS + DAY
    const archived = [entry(1, old), entry(2, old + 1000)]
    const unsynced = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => ({
      orderUuid: `q${i}`, outletId: 'out1', capturedAt: iso(NOW - DAY), seq: i + 1,
    }))
    expect([...prunable(archived, { unsynced, referenced: new Set() }, NOW)].sort()).toEqual(['u1', 'u2'])
    // fewer unsynced: the archived ones fit under the floor
    expect(prunable(archived, { unsynced: unsynced.slice(0, 10), referenced: new Set() }, NOW).size).toBe(0)
  })

  it('never prunes a receipt referenced by an unacknowledged refund (by uuid or by server id)', () => {
    const old = RECEIPT_RETENTION_MS + DAY
    const filler = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(100 + i, DAY + i))
    const a = entry(1, old, { serverOrderId: 'srv-1' })
    const b = entry(2, old + 1000)
    const c = entry(3, old + 2000)
    const dropped = prunable([...filler, a, b, c], { unsynced: [], referenced: new Set(['u2', 'srv-1']) }, NOW)
    expect([...dropped]).toEqual(['u3'])
  })

  it('ranks each outlet separately', () => {
    const old = RECEIPT_RETENTION_MS + DAY
    const other = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(1000 + i, DAY + i, { outletId: 'out2' }))
    const mine = entry(1, old)
    expect(prunable([...other, mine], noCtx, NOW).size).toBe(0)
  })

  it('keeps a receipt whose capture time cannot be read', () => {
    const filler = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(100 + i, DAY + i))
    const bad = entry(1, 0, { capturedAt: 'not a date' })
    expect(prunable([...filler, bad], noCtx, NOW).size).toBe(0)
  })
})

describe('receiptEntryFromItem', () => {
  const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
    idempotencyKey: 'dev:u1', type: 'order', seq: 7, status: 'acked', clientCreatedAt: iso(NOW - 1000),
    envelope: { v: 1, outletId: 'out1', userId: 'usr', deviceId: 'dev', capturedAt: iso(NOW - 2000), shiftId: 'sh1' },
    payload: {
      orderUuid: 'u1', deviceId: 'dev', orderNumber: 'ORD-1', paymentMethod: 'qris', quotedTotal: 250000,
      customerId: 'c1', customerName: 'Budi', notes: 'rahasia', salesmanId: 's1', salesmanName: 'Sari',
      items: [{ productId: 'p', quantity: 1 }], receiptSnapshot: { total: 250000, lines: [] },
    },
    ...over,
  } as OutboxItem)

  it('copies only receipt facts and never customer, notes or salesman data', () => {
    const e = receiptEntryFromItem({ ...item(), ackedOrderId: 'srv-1' } as OutboxItem)!
    expect(e).toMatchObject({
      orderUuid: 'u1', idempotencyKey: 'dev:u1', serverOrderId: 'srv-1', orderNumber: 'ORD-1',
      capturedAt: iso(NOW - 2000), outletId: 'out1', shiftId: 'sh1', paymentMethod: 'qris', quotedTotal: 250000,
      receiptSnapshot: { total: 250000, lines: [] },
    })
    const json = JSON.stringify(e)
    for (const secret of ['Budi', 'c1', 'rahasia', 'Sari', 'customer', 'salesman', 'notes']) expect(json).not.toContain(secret)
  })

  it('has no serverOrderId when the ack carried none', () => {
    expect('serverOrderId' in receiptEntryFromItem(item())!).toBe(false)
  })

  it('returns null for anything that is not an order with a uuid and number', () => {
    expect(receiptEntryFromItem(item({ type: 'refund' }))).toBeNull()
    expect(receiptEntryFromItem(item({ payload: { orderNumber: 'x' } }))).toBeNull()
    expect(receiptEntryFromItem(item({ payload: { orderUuid: 'u1' } }))).toBeNull()
  })

  it('falls back to clientCreatedAt when the item has no envelope', () => {
    const e = receiptEntryFromItem(item({ envelope: undefined }))!
    expect(e.capturedAt).toBe(iso(NOW - 1000))
    expect(e.outletId).toBe('')
    expect(e.shiftId).toBeNull()
  })
})

describe('ReceiptArchive', () => {
  const stored = (store: Map<string, string>): ReceiptEntry[] => JSON.parse(store.get(RECEIPT_ARCHIVE_KEY) ?? '[]')

  it('stores entries durably and reads them back after a restart', async () => {
    const { kv, store } = controllableKV()
    await new ReceiptArchive(kv).addMany([entry(1, DAY)], () => noCtx)
    expect(stored(store).map((e) => e.orderUuid)).toEqual(['u1'])
    expect(new ReceiptArchive(kv).entries().map((e) => e.orderUuid)).toEqual(['u1'])
  })

  it('dedupes by orderUuid even when the order number repeats, keeping a known server id', async () => {
    const { kv } = controllableKV()
    const a = new ReceiptArchive(kv)
    await a.addMany([entry(1, DAY, { serverOrderId: 'srv-1', orderNumber: 'SAME' })], () => noCtx)
    await a.addMany([entry(1, DAY, { orderNumber: 'SAME' }), entry(2, DAY, { orderNumber: 'SAME' })], () => noCtx)
    const all = a.entries()
    expect(all.map((e) => e.orderUuid).sort()).toEqual(['u1', 'u2'])
    expect(all.find((e) => e.orderUuid === 'u1')!.serverOrderId).toBe('srv-1')
  })

  it('rejects a failed write and leaves memory and storage unchanged', async () => {
    const { kv, store, ctl } = controllableKV()
    const a = new ReceiptArchive(kv)
    await a.addMany([entry(1, DAY)], () => noCtx)
    ctl.mode = 'reject'
    await expect(a.addMany([entry(2, DAY)], () => noCtx)).rejects.toThrow('QuotaExceeded')
    expect(a.entries().map((e) => e.orderUuid)).toEqual(['u1'])
    expect(stored(store).map((e) => e.orderUuid)).toEqual(['u1'])
    ctl.mode = 'ok'
    await a.addMany([entry(2, DAY)], () => noCtx)
    expect(a.entries().map((e) => e.orderUuid)).toEqual(['u1', 'u2'])
  })

  it('prunes with a context read inside the write chain, and writes nothing when nothing changes', async () => {
    const { kv, ctl } = controllableKV()
    const a = new ReceiptArchive(kv)
    const old = RECEIPT_RETENTION_MS + DAY
    const filler = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(100 + i, DAY + i))
    await a.addMany([...filler, entry(1, old), entry(2, old + 1)], () => noCtx)
    expect(a.entries().map((e) => e.orderUuid)).not.toContain('u1')
    expect(a.entries().map((e) => e.orderUuid)).not.toContain('u2')
    const writes = ctl.attempts.length
    await a.addMany([], () => noCtx)
    expect(ctl.attempts.length).toBe(writes)
  })

  it('a referenced receipt survives the prune that drops its neighbour', async () => {
    const { kv } = controllableKV()
    const a = new ReceiptArchive(kv)
    const old = RECEIPT_RETENTION_MS + DAY
    const filler = Array.from({ length: RECEIPT_KEEP_NEWEST }, (_, i) => entry(100 + i, DAY + i))
    await a.addMany([...filler, entry(1, old), entry(2, old + 1)], () => ({ unsynced: [], referenced: new Set(['u1']) }))
    const ids = a.entries().map((e) => e.orderUuid)
    expect(ids).toContain('u1')
    expect(ids).not.toContain('u2')
  })

  it('logs the archive size (receipts and bytes) after each write, none when nothing changed', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { kv } = controllableKV()
    const a = new ReceiptArchive(kv)
    await a.addMany([entry(1, DAY), entry(2, DAY)], () => noCtx)
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toMatch(/receipt archive: 2 receipts, \d+ bytes/)
    await a.addMany([], () => noCtx)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('is empty and safe on corrupt storage', () => {
    const { kv } = controllableKV({ [RECEIPT_ARCHIVE_KEY]: '{broken' })
    expect(new ReceiptArchive(kv).entries()).toEqual([])
  })

  it('serializes concurrent writes so none is lost', async () => {
    const { kv } = controllableKV()
    const a = new ReceiptArchive(kv)
    await Promise.all([1, 2, 3].map((n) => a.addMany([entry(n, DAY)], () => noCtx)))
    expect(a.entries().map((e) => e.orderUuid).sort()).toEqual(['u1', 'u2', 'u3'])
  })
})
