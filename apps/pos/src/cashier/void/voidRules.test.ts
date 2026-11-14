import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import type { AppUser, Shift } from '@mandalika/types'
import {
  buildVoidPayload, parkedVoidNote, voidAvailability, voidReasonProblem, VOID_REASONS, type LocalVoidSale,
} from './voidRules'

type Order = components['schemas']['Order']

const user = (permissions: string[] = [], role = 'cashier'): AppUser => ({ role, permissions } as unknown as AppUser)
const shift = (id: string, openedAt = '2026-11-14T08:00:00Z'): Shift => ({
  id, outletId: 'o1', cashierId: 'c1', cashierName: 'C', status: 'open', openedAt, startingCash: 0,
  totalSales: 0, totalOrders: 0, totalRefunds: 0, cashSales: 0, cardSales: 0, transferSales: 0, qrisSales: 0,
} as Shift)
const order = (over: Partial<Order> = {}): Order => ({
  id: 'ord1', orderNumber: 'BSD-0001', outletId: 'o1', cashierId: 'c1', cashierName: 'C', items: [], subtotal: 100000,
  discountAmount: 0, taxAmount: 0, total: 100000, paymentMethod: 'cash', amountPaid: 100000, change: 0, status: 'completed',
  createdAt: '2026-11-14T09:00:00Z', shiftId: 's1', ...over,
} as Order)
const base = { user: user(['void_own_shift']), deviceId: 'dev1', currentShift: shift('s1'), queuedVoidIds: new Set<string>(), queuedRefundIds: new Set<string>(), syncedVoidIds: new Set<string>(), queuedReplacementOf: new Set<string>() }

describe('voidAvailability', () => {
  it('shows void for own open shift with void_own_shift', () => {
    expect(voidAvailability({ ...base, order: order() })).toEqual({ kind: 'void' })
  })
  it('blocks without the permission', () => {
    expect(voidAvailability({ ...base, user: user(), order: order() })).toEqual({ kind: 'blocked', label: 'Butuh izin batalkan transaksi' })
  })
  it('blocks another shift with Batalkan lewat Backoffice', () => {
    expect(voidAvailability({ ...base, order: order({ shiftId: 's0' }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
  })
  it('offers create_replacement on a later-mode voided sale for void_any', () => {
    const o = order({ status: 'cancelled', void: { mode: 'later' } as Order['void'] })
    expect(voidAvailability({ ...base, user: user(['void_any']), order: o })).toEqual({ kind: 'create_replacement' })
    expect(voidAvailability({ ...base, order: o })).toEqual({ kind: 'hidden' })
    const done = order({ status: 'cancelled', void: { mode: 'later', followup: 'no_replacement' } as Order['void'] })
    expect(voidAvailability({ ...base, user: user(['void_any']), order: done })).toEqual({ kind: 'hidden' })
  })
  it('hides create_replacement while its replacement is queued', () => {
    const o = order({ status: 'cancelled', void: { mode: 'later' } as Order['void'] })
    expect(voidAvailability({ ...base, user: user(['void_any']), order: o, queuedReplacementOf: new Set(['ord1']) })).toEqual({ kind: 'hidden' })
  })
  it('does not offer Batalkan again for a sale whose void this tablet saw acknowledged', () => {
    expect(voidAvailability({ ...base, order: order(), syncedVoidIds: new Set(['ord1']) })).toEqual({ kind: 'hidden' })
  })
  it('blocks refunded statuses only; other states are hidden', () => {
    expect(voidAvailability({ ...base, order: order({ status: 'refunded' }) })).toEqual({ kind: 'blocked', label: 'Sudah direfund' })
    expect(voidAvailability({ ...base, order: order({ status: 'weird' as Order['status'] }) })).toEqual({ kind: 'hidden' })
  })
  it('needs the current shift to be open', () => {
    expect(voidAvailability({ ...base, currentShift: { ...shift('s1'), status: 'closed' }, order: order() })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
  })
  it('hides a sale that is already voided', () => {
    expect(voidAvailability({ ...base, order: order({ status: 'cancelled', void: { mode: 'none' } as Order['void'] }) })).toEqual({ kind: 'hidden' })
  })
  it('blocks with Shift masih tersimpan di tablet while the open is pending', () => {
    expect(voidAvailability({ ...base, currentShift: shift(''), order: order({ shiftId: '' }) })).toEqual({ kind: 'blocked', label: 'Shift masih tersimpan di tablet' })
  })
  it('treats an unattributed sale from this device after openedAt as own shift', () => {
    expect(voidAvailability({ ...base, order: order({ shiftId: null, deviceId: 'dev1' }) })).toEqual({ kind: 'void' })
    expect(voidAvailability({ ...base, order: order({ shiftId: null, deviceId: 'dev2' }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
    expect(voidAvailability({ ...base, order: order({ shiftId: null, deviceId: 'dev1', createdAt: '2026-11-14T07:00:00Z' }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
  })
  it('never matches empty shift ids', () => {
    expect(voidAvailability({ ...base, order: order({ shiftId: '' }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
    expect(voidAvailability({ ...base, currentShift: null, order: order({ shiftId: null }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
    expect(voidAvailability({ ...base, currentShift: shift(''), order: order({ shiftId: null }) })).toEqual({ kind: 'blocked', label: 'Shift masih tersimpan di tablet' })
  })
  it('blocks a refunded sale', () => {
    const blocked = { kind: 'blocked', label: 'Sudah direfund' }
    expect(voidAvailability({ ...base, order: order({ refunds: [{ id: 'r' } as never] }) })).toEqual(blocked)
    expect(voidAvailability({ ...base, order: order({ status: 'partially_refunded' }) })).toEqual(blocked)
    expect(voidAvailability({ ...base, order: order(), queuedRefundIds: new Set(['ord1']) })).toEqual(blocked)
  })
  it('blocks while a void is queued', () => {
    expect(voidAvailability({ ...base, order: order(), queuedVoidIds: new Set(['ord1']) })).toEqual({ kind: 'blocked', label: 'Pembatalan menunggu terkirim' })
  })
  it('a parked void shows its reason and lets the cashier void again', () => {
    // A parked void is not in queuedVoidIds (engine.queuedVoidOrderIds skips it), so the sale stays voidable.
    expect(voidAvailability({ ...base, order: order() })).toEqual({ kind: 'void' })
    expect(parkedVoidNote([
      { orderId: 'ord1', parked: true, reviewReason: 'Perlu ditinjau' },
      { orderId: 'ord2', parked: true, reviewReason: 'lain' },
      { orderId: 'ord1', parked: false, reviewReason: 'x' },
    ], ['ord1'])).toBe('Perlu ditinjau')
    expect(parkedVoidNote([], ['ord1'])).toBeNull()
  })
  it('handles local sales by uuid, with local flags', () => {
    const sale = (over: Partial<LocalVoidSale> = {}): LocalVoidSale => ({
      orderUuid: 'u1', orderNumber: 'BSD-9', total: 5000, shiftId: 's1', capturedAt: '2026-11-14T09:00:00Z', ...over,
    })
    expect(voidAvailability({ ...base, order: sale() })).toEqual({ kind: 'void' })
    expect(voidAvailability({ ...base, order: sale(), queuedVoidIds: new Set(['u1']) })).toEqual({ kind: 'blocked', label: 'Pembatalan menunggu terkirim' })
    expect(voidAvailability({ ...base, order: sale({ voided: true }) })).toEqual({ kind: 'hidden' })
    expect(voidAvailability({ ...base, order: sale({ refundQueued: true }) })).toEqual({ kind: 'blocked', label: 'Sudah direfund' })
    expect(voidAvailability({ ...base, order: sale({ shiftId: null }) })).toEqual({ kind: 'void' })
    expect(voidAvailability({ ...base, order: sale({ shiftId: null, capturedAt: '2026-11-14T07:00:00Z' }) })).toEqual({ kind: 'blocked', label: 'Batalkan lewat Backoffice' })
  })
})

describe('voidReasonProblem', () => {
  it('requires a reason and 10 characters for lainnya', () => {
    expect(voidReasonProblem(null, '')).toBe('Pilih alasan')
    expect(voidReasonProblem('salah_barang', '')).toBeNull()
    expect(voidReasonProblem('lainnya', '  pendek  ')).toBe('Catatan wajib diisi minimal 10 karakter untuk alasan Lainnya.')
    expect(voidReasonProblem('lainnya', 'sepuluh kar')).toBeNull()
    expect(voidReasonProblem('salah_barang', 'x'.repeat(501))).toBe('Catatan maksimal 500 karakter')
    expect(VOID_REASONS.map((r) => r.code)[0]).toBe('salah_metode_pembayaran')
    expect(VOID_REASONS).toHaveLength(7)
  })
})

describe('buildVoidPayload', () => {
  const lines = [
    { productId: 'p1', productName: 'A', variantSize: '30ml', price: 1, quantity: 2, subtotal: 2 },
    { productId: 'p1', productName: 'A', variantSize: '30ml', price: 1, quantity: 1, subtotal: 1 },
    { productId: 'p2', productName: 'B', variantSize: '2ml', price: 1, quantity: 1, subtotal: 1, isReward: true },
  ]
  it('names an unsynced sale by saleOrderUuid and leaves orderId empty', () => {
    const p = buildVoidPayload({
      order: { orderUuid: 'u1', orderNumber: 'BSD-9', total: 5000, shiftId: 's1', capturedAt: 'x', lines: [{ productId: 'p1', variantSize: '30ml', quantity: 1 }], tenders: [{ method: 'qris', amount: 5000, reference: 'R1' }] },
      reason: 'salah_barang', note: ' ', mode: 'none',
    })
    expect(p).toMatchObject({
      orderId: '', saleOrderUuid: 'u1', reasonCode: 'salah_barang', mode: 'none', orderNumber: 'BSD-9', total: 5000,
      originalShiftId: 's1', originalTenders: [{ method: 'qris', amount: 5000, reference: 'R1' }],
      restockLines: [{ productId: 'p1', variantSize: '30ml', quantity: 1 }],
    })
    expect(p).not.toHaveProperty('note')
    expect(p).not.toHaveProperty('replacement')
  })
  it('writes restockLines from the order items, merged, with the giveaway unit', () => {
    const p = buildVoidPayload({
      order: order({ items: lines as Order['items'], tenders: [{ seq: 1, method: 'cash', amount: 100000, tendered: 150000, change: 50000, synthetic: false }] }),
      reason: 'lainnya', note: ' catatan panjang ok ', mode: 'replace', replacement: { orderUuid: 'n1' },
      stockChoices: { k: 'skip_counted' }, giveaway: { productId: 'g', variantSize: '1ml' },
    })
    expect(p.orderId).toBe('ord1')
    expect(p).not.toHaveProperty('saleOrderUuid')
    expect(p.note).toBe('catatan panjang ok')
    expect(p.restockLines).toEqual([
      { productId: 'p1', variantSize: '30ml', quantity: 3 },
      { productId: 'p2', variantSize: '2ml', quantity: 1 },
      { productId: 'g', variantSize: '1ml', quantity: 1 },
    ])
    expect(p.originalTenders).toEqual([{ method: 'cash', amount: 100000 }])
    expect(p.stockChoices).toEqual({ k: 'skip_counted' })
    expect(p.replacement).toEqual({ orderUuid: 'n1' })
  })
  it('trims cash change off the captured tenders of a local sale (applied amounts)', () => {
    const p = buildVoidPayload({
      order: { orderUuid: 'u1', orderNumber: 'BSD-9', total: 100000, shiftId: 's1', capturedAt: 'x', tenders: [{ method: 'qris', amount: 60000 }, { method: 'cash', amount: 100000 }] },
      reason: 'salah_barang', note: '', mode: 'none',
    })
    expect(p.originalTenders).toEqual([{ method: 'qris', amount: 60000 }, { method: 'cash', amount: 40000 }])
  })
  it('throws for mode replace without a replacement', () => {
    expect(() => buildVoidPayload({ order: order(), reason: 'salah_barang', note: '', mode: 'replace' })).toThrow()
  })
  it('falls back to a single tender line and omits the replacement for mode none', () => {
    const p = buildVoidPayload({ order: order(), reason: 'salah_barang', note: '', mode: 'none', replacement: { a: 1 } })
    expect(p.originalTenders).toEqual([{ method: 'cash', amount: 100000 }])
    expect(p).not.toHaveProperty('replacement')
  })
})
