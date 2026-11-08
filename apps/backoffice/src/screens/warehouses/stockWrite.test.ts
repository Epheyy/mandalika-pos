import { describe, expect, it } from 'vitest'
import { ApiError, type WarehouseStockRow } from '@mandalika/api'
import { AMBIGUOUS_HINT, KEY_CONFLICT_MESSAGE, goodsLineErrors, goodsLineKey, goodsReceiptItems, isAmbiguousFailure, isKeyConflict, stockChangeLine, stockWriteError } from './stockWrite'

const row = (productId: string, variantSize: string): WarehouseStockRow =>
  ({ productId, productName: productId, variantSize, sku: null, stock: 0 }) as unknown as WarehouseStockRow

describe('isKeyConflict', () => {
  it('is true only for the key-reuse 409', () => {
    expect(isKeyConflict(new ApiError(409, 'kunci idempotensi sudah dipakai untuk operasi lain'))).toBe(true)
    expect(isKeyConflict(new ApiError(409, 'Kunci idempotensi sudah dipakai untuk operasi lain'))).toBe(true)
  })

  it('is false for the other 409s and for anything else', () => {
    expect(isKeyConflict(new ApiError(409, 'terjadi konflik data, coba lagi'))).toBe(false)
    expect(isKeyConflict(new ApiError(409, 'persetujuan wajib', 'http', { data: { code: 'approval_required' } }))).toBe(false)
    expect(isKeyConflict(new ApiError(500, 'kunci idempotensi'))).toBe(false)
    expect(isKeyConflict(new Error('kunci idempotensi'))).toBe(false)
    expect(isKeyConflict(null)).toBe(false)
  })
})

describe('stockWriteError', () => {
  it('turns a key conflict into the already-recorded message', () => {
    expect(stockWriteError(new ApiError(409, 'kunci idempotensi sudah dipakai untuk operasi lain'), 'x')).toBe(KEY_CONFLICT_MESSAGE)
  })

  it('keeps the server text of any other refusal and falls back for a non-error', () => {
    expect(stockWriteError(new ApiError(422, 'stok tidak cukup'), 'x')).toBe('stok tidak cukup')
    expect(stockWriteError('boom', 'Gagal')).toBe('Gagal')
  })

  it('tells the user to press save again in the same panel when the outcome is unknown', () => {
    const msg = stockWriteError(new ApiError(503, 'layanan tidak tersedia'), 'x')
    expect(msg.startsWith('layanan tidak tersedia.')).toBe(true)
    expect(msg.endsWith(AMBIGUOUS_HINT)).toBe(true)
    expect(stockWriteError(new ApiError(0, 'network error', 'network'), 'x')).toContain('tekan simpan lagi')
  })

  it('does not call a deterministic refusal ambiguous', () => {
    expect(isAmbiguousFailure(new ApiError(422, 'x'))).toBe(false)
    expect(isAmbiguousFailure(new ApiError(409, 'x'))).toBe(false)
    expect(isAmbiguousFailure(new ApiError(500, 'x'))).toBe(true)
    expect(isAmbiguousFailure(new ApiError(0, 'x', 'timeout'))).toBe(true)
  })
})

describe('goodsReceiptItems', () => {
  const rows = [row('a', 'S'), row('b', 'M'), row('c', 'L')]

  it('keeps only lines with a quantity above zero, in row order, with an optional cost', () => {
    const items = goodsReceiptItems(rows, {
      'a|S': { qty: '3', unitCost: '' },
      'b|M': { qty: '0', unitCost: '5000' },
      'c|L': { qty: '2', unitCost: ' 7500 ' },
    })
    expect(items).toEqual([
      { productId: 'a', variantSize: 'S', qty: 3, unitCost: null },
      { productId: 'c', variantSize: 'L', qty: 2, unitCost: 7500 },
    ])
  })

  it('drops a negative or non-numeric quantity and sends nothing for no lines', () => {
    expect(goodsReceiptItems(rows, { 'a|S': { qty: '-2', unitCost: '' }, 'b|M': { qty: 'x', unitCost: '' } })).toEqual([])
    expect(goodsReceiptItems(rows, {})).toEqual([])
  })
})

describe('stockChangeLine', () => {
  it('shows the delta with a sign', () => {
    expect(stockChangeLine(9, 7)).toBe('Stok sekarang 9 → baru 7 (−2)')
    expect(stockChangeLine(7, 9)).toBe('Stok sekarang 7 → baru 9 (+2)')
    expect(stockChangeLine(5, 5)).toBe('Stok sekarang 5 → baru 5 (0)')
  })

  it('has no line until the new quantity is usable', () => {
    expect(stockChangeLine(9, null)).toBeNull()
  })
})

describe('goodsLineErrors (F03/F04)', () => {
  const rows = [{ productId: 'p1', variantSize: '50ml', productName: 'A' }] as unknown as Parameters<typeof goodsLineErrors>[0]
  const key = goodsLineKey('p1', '50ml')
  it('flags a decimal quantity and a negative cost next to their fields', () => {
    expect(goodsLineErrors(rows, { [key]: { qty: '1.5', unitCost: '' } })[key]?.qty).toMatch(/bulat/)
    expect(goodsLineErrors(rows, { [key]: { qty: '2', unitCost: '-1' } })[key]?.unitCost).toMatch(/negatif/)
  })
  it('accepts whole quantities, zero cost and empty lines', () => {
    expect(goodsLineErrors(rows, { [key]: { qty: '2', unitCost: '0' } })).toEqual({})
    expect(goodsLineErrors(rows, { [key]: { qty: '', unitCost: '' } })).toEqual({})
  })
})
