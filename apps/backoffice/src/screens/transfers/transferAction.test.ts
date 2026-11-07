import { describe, expect, it } from 'vitest'
import { ApiError } from '@mandalika/api'
import {
  IDEMPOTENCY_CONFLICT_MESSAGE,
  effectiveLocation,
  isIdempotencyConflict,
  TRANSFER_CHANGED_MESSAGE,
  transferActionError,
  transferChangedSince,
  transferSnapshot,
  transferConfirmCopy,
  transferUnits,
} from './transferAction'

const transfer = (status: string) => ({
  transferNo: 'TRF-7',
  status: status as 'draft',
  source: { kind: 'warehouse' as const, id: 'w1', name: 'Gudang Pusat' },
  dest: { kind: 'outlet' as const, id: 'o1', name: 'BSD' },
  items: [
    { productId: 'p1', productName: 'A', variantSize: '30ml', sentQty: 4 },
    { productId: 'p2', productName: 'B', variantSize: '50ml', sentQty: 8 },
  ],
})

describe('transferConfirmCopy', () => {
  it('counts the sent units and names the source on Kirim', () => {
    expect(transferUnits(transfer('draft'))).toBe(12)
    const copy = transferConfirmCopy('send', transfer('draft'))
    expect(copy.title).toBe('Kirim transfer TRF-7?')
    expect(copy.consequence).toBe('Stok 12 unit akan keluar dari Gudang Pusat sekarang dan tercatat “Dikirim” sampai BSD menerima.')
    expect(copy.tone).toBe('default')
  })

  it('says a draft cancel moves no stock and a sent cancel returns it', () => {
    expect(transferConfirmCopy('cancel', transfer('draft')).consequence).toBe('Draf transfer dibatalkan. Stok tidak berubah.')
    const sent = transferConfirmCopy('cancel', transfer('in_transit'))
    expect(sent.consequence).toBe('Stok 12 unit dikembalikan ke Gudang Pusat sekarang.')
    expect(sent.tone).toBe('danger')
    expect(sent.cancelLabel).not.toBe(sent.confirmLabel)
  })
})

describe('transferActionError', () => {
  it('tells a reused key apart from other refusals', () => {
    const conflict = new ApiError(409, 'Idempotency-Key dipakai ulang', 'http', { data: { code: 'idempotency_conflict' } })
    expect(isIdempotencyConflict(conflict)).toBe(true)
    expect(transferActionError(conflict)).toBe(IDEMPOTENCY_CONFLICT_MESSAGE)
    const real = new ApiError(409, 'kunci idempotensi sudah dipakai untuk operasi lain', 'http', { error: 'kunci idempotensi sudah dipakai untuk operasi lain' })
    expect(isIdempotencyConflict(real)).toBe(true)
    expect(transferActionError(real)).toBe(IDEMPOTENCY_CONFLICT_MESSAGE)
    const state = new ApiError(409, 'Transfer sudah dikirim', 'http', { data: { code: 'invalid_state' } })
    expect(isIdempotencyConflict(state)).toBe(false)
    expect(transferActionError(state)).toBe('Transfer sudah dikirim')
    expect(isIdempotencyConflict(new ApiError(500, 'x'))).toBe(false)
  })

  it('falls back to a generic message for anything else', () => {
    expect(transferActionError('boom')).toBe('Aksi gagal.')
    expect(transferActionError(new Error(''))).toBe('Aksi gagal.')
  })
})

describe('effectiveLocation', () => {
  it('uses the Lokasi filter, else the header outlet, else everything', () => {
    expect(effectiveLocation('warehouse:w1', 'o1')).toEqual({ kind: 'warehouse', id: 'w1' })
    expect(effectiveLocation('', 'o1')).toEqual({ kind: 'outlet', id: 'o1' })
    expect(effectiveLocation('', null)).toBeNull()
  })

  it('ignores a malformed key', () => {
    expect(effectiveLocation('nonsense', null)).toBeNull()
    expect(effectiveLocation('outlet:', null)).toBeNull()
  })
})

describe('transferChangedSince', () => {
  it('is false for the same status and units, true when either moved', () => {
    const opened = transferSnapshot(transfer('draft'))
    expect(transferChangedSince(opened, transfer('draft'))).toBe(false)
    expect(transferChangedSince(opened, transfer('in_transit'))).toBe(true)
    expect(transferChangedSince(opened, { ...transfer('draft'), items: [{ productId: 'p1', productName: 'A', variantSize: '30ml', sentQty: 5 }] })).toBe(true)
    expect(TRANSFER_CHANGED_MESSAGE).not.toBe('')
  })
})
