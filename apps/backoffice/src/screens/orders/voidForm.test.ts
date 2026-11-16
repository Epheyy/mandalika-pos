import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@mandalika/api'
import type { Order } from '@mandalika/api'
import {
  bundleBlocksPerbaiki, countedChoices, nextVoidAttempt, submitVoid, tendersFromOrder, voidAttemptKey, voidFormProblem,
  voidRequestBody, type VoidFormValues,
} from './voidForm'

const base = (over: Partial<VoidFormValues> = {}): VoidFormValues => ({
  reason: 'salah_barang', note: '', choice: 'saja', tenders: [], originalTotal: 300000, ...over,
})
const UUID = '6f1d2c3a-8b4e-4f5a-9c7d-1e2f3a4b5c6d'

describe('voidFormProblem', () => {
  it('requires a reason', () => {
    expect(voidFormProblem(base({ reason: null }))).toBe('Pilih alasan pembatalan.')
  })
  it('lainnya needs 10 characters', () => {
    expect(voidFormProblem(base({ reason: 'lainnya', note: '  pendek  ' }))).toBe('Catatan wajib diisi minimal 10 karakter untuk alasan Lainnya.')
    expect(voidFormProblem(base({ reason: 'lainnya', note: 'sepuluh huruf' }))).toBeNull()
  })
  it('an optional note is capped at 500 characters', () => {
    expect(voidFormProblem(base({ note: 'a'.repeat(501) }))).toBe('Catatan paling banyak 500 karakter.')
    expect(voidFormProblem(base({ note: 'a'.repeat(500) }))).toBeNull()
  })
  it('perbaiki requires tenders summing to the original total', () => {
    const f = base({ choice: 'perbaiki', tenders: [{ method: 'cash', amount: 100000 }, { method: 'qris', amount: 150000 }] })
    expect(voidFormProblem(f)).toBe('Jumlah pembayaran pengganti harus sama dengan yang diterima (Rp 300.000).')
    expect(voidFormProblem({ ...f, tenders: [{ method: 'cash', amount: 100000 }, { method: 'qris', amount: 200000 }] })).toBeNull()
  })
  it('perbaiki refuses an empty method or a non-positive amount', () => {
    const msg = 'Isi metode dan jumlah pada tiap baris pembayaran.'
    expect(voidFormProblem(base({ choice: 'perbaiki', tenders: [{ method: '', amount: 300000 }] }))).toBe(msg)
    expect(voidFormProblem(base({ choice: 'perbaiki', tenders: [{ method: 'cash', amount: 0 }, { method: 'qris', amount: 300000 }] }))).toBe(msg)
  })
  it('saja and pengganti_pos ignore the tenders', () => {
    expect(voidFormProblem(base({ choice: 'pengganti_pos', tenders: [{ method: 'cash', amount: 1 }] }))).toBeNull()
  })
})

describe('voidRequestBody', () => {
  it('saja maps to mode none, with no replacement', () => {
    expect(voidRequestBody(base(), UUID)).toEqual({ reasonCode: 'salah_barang', clientVoidUuid: UUID, mode: 'none' })
  })
  it('pengganti_pos maps to mode later', () => {
    expect(voidRequestBody(base({ choice: 'pengganti_pos' }), UUID).mode).toBe('later')
  })
  it('perbaiki maps to mode replace with tenders; the customer only when changed; never items', () => {
    const tenders = [{ method: 'qris', amount: 300000 }]
    const b = voidRequestBody(base({ choice: 'perbaiki', tenders, customerId: 'c-1' }), UUID)
    expect(b.mode).toBe('replace')
    expect(b.replacement).toEqual({ tenders, customerId: 'c-1' })
    expect(Object.keys(b)).not.toContain('items')
    expect(voidRequestBody(base({ choice: 'perbaiki', tenders }), UUID).replacement).toEqual({ tenders })
  })
  it('trims the note, drops an empty one and sends the stock choices', () => {
    const b = voidRequestBody(base({ note: '  salah ukuran  ', stockChoices: { k1: 'skip_counted' } }), UUID)
    expect(b.note).toBe('salah ukuran')
    expect(b.stockChoices).toEqual({ k1: 'skip_counted' })
    expect(voidRequestBody(base({ note: '   ' }), UUID).note).toBeUndefined()
  })
})

describe('submitVoid', () => {
  const body = voidRequestBody(base(), UUID)
  it('returns the cancelled order on success', async () => {
    const order = { id: 'o1', status: 'cancelled' } as Order
    const api = { voidOrder: vi.fn().mockResolvedValue(order) }
    expect(await submitVoid(api, 'o1', body)).toEqual({ ok: true, order })
    expect(api.voidOrder).toHaveBeenCalledWith('o1', body)
  })
  it('submitVoid surfaces the server message on 409', async () => {
    const api = { voidOrder: vi.fn().mockRejectedValue(new ApiError(409, 'Transaksi ini sudah dibatalkan.')) }
    expect(await submitVoid(api, 'o1', body)).toEqual({ ok: false, message: 'Transaksi ini sudah dibatalkan.' })
  })
  it('gives a generic message when there was no server answer', async () => {
    const api = { voidOrder: vi.fn().mockRejectedValue(new ApiError(0, 'Failed to fetch', 'network')) }
    const r = await submitVoid(api, 'o1', body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/Cek koneksi/)
  })
})

describe('retry key', () => {
  it('a uuid is kept across a retry of the same form, and renewed when the form changes', () => {
    const gen = vi.fn().mockReturnValueOnce('u1').mockReturnValueOnce('u2')
    const a = nextVoidAttempt(null, voidAttemptKey(base()), gen)
    expect(nextVoidAttempt(a, voidAttemptKey(base()), gen)).toBe(a)
    expect(a.uuid).toBe('u1')
    const b = nextVoidAttempt(a, voidAttemptKey(base({ reason: 'salah_promo' })), gen)
    expect(b.uuid).toBe('u2')
  })
})

describe('order helpers', () => {
  const item = (extra: object) => ({ productId: 'p', productName: 'X', variantSize: '30ml', price: 1, quantity: 1, subtotal: 1, ...extra })
  it('detects a bundle order from the bundle group on any line', () => {
    expect(bundleBlocksPerbaiki({ items: [item({}), item({ bundleGroup: 1, bundleRole: 'large' })] } as Order)).toBe(true)
    expect(bundleBlocksPerbaiki({ items: [item({})] } as Order)).toBe(false)
  })
  it('starts the replacement tenders from the original lines, or one line for an old order', () => {
    const o = { total: 300000, paymentMethod: 'split', tenders: [
      { seq: 2, method: 'qris', amount: 100000, tendered: 100000, change: 0, synthetic: false },
      { seq: 1, method: 'cash', amount: 200000, tendered: 250000, change: 50000, synthetic: false },
    ] } as unknown as Order
    expect(tendersFromOrder(o)).toEqual([{ method: 'cash', amount: 200000 }, { method: 'qris', amount: 100000 }])
    expect(tendersFromOrder({ total: 90000, paymentMethod: 'cash' } as Order)).toEqual([{ method: 'cash', amount: 90000 }])
  })
  it('sends a choice for every counted line, restock by default', () => {
    const lines = [
      { key: 'a', countedAfter: true }, { key: 'b', countedAfter: false }, { key: 'c', countedAfter: true },
    ] as Parameters<typeof countedChoices>[0]
    expect(countedChoices(lines, { c: 'skip_counted' })).toEqual({ a: 'restock', c: 'skip_counted' })
    expect(countedChoices([lines[1]!], {})).toEqual({})
  })
})
