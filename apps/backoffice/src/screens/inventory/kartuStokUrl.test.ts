import { describe, expect, it } from 'vitest'
import { parseHash } from '../../lib/router/hash'
import { parseListState, serializeListState } from '../../lib/router/useListState'
import { KARTU_SCHEMA, decodeSku, encodeSku, kartuStokHash, parseJenis, rememberedSkuLabel, serializeJenis, withGroupSelection } from './kartuStokUrl'

describe('kartuStokUrl', () => {
  it('round-trips a SKU, also with a bar or spaces in the size', () => {
    for (const size of ['Std', '100 ml', 'A|B', '50ml/edp']) {
      expect(decodeSku(encodeSku({ productId: 'p-1', variantSize: size }))).toEqual({ productId: 'p-1', variantSize: size })
    }
  })

  it('refuses a SKU without a product or a size', () => {
    expect(decodeSku('')).toBeNull()
    expect(decodeSku('p-1')).toBeNull()
    expect(decodeSku('|Std')).toBeNull()
    expect(decodeSku('p-1|')).toBeNull()
  })

  it('reads jenis into kinds and flags and drops the unknown', () => {
    expect(parseJenis('sale,hadiah,zz,minus,receipt')).toEqual({ kinds: ['sale', 'receipt'], giveaway: true, shortage: true })
    expect(parseJenis('')).toEqual({ kinds: [], giveaway: false, shortage: false })
  })

  it('writes jenis in a stable order', () => {
    expect(serializeJenis({ kinds: ['receipt', 'sale'], giveaway: true, shortage: false })).toBe('sale,receipt,hadiah')
    expect(serializeJenis(parseJenis('hadiah,sale'))).toBe('sale,hadiah')
  })

  it('replaces one chip group and keeps the others', () => {
    const current = parseJenis('sale,adjust,hadiah')
    const transfer = ['transfer_out', 'transfer_in', 'transfer_cancel']
    expect(withGroupSelection(current, transfer, ['transfer_in'])).toEqual({ kinds: ['sale', 'transfer_in', 'adjust'], giveaway: true, shortage: false })
    expect(withGroupSelection(current, ['hadiah'], [])).toEqual({ kinds: ['sale', 'adjust'], giveaway: false, shortage: false })
    expect(withGroupSelection(current, ['minus'], ['minus', 'sale'])).toEqual({ kinds: ['sale', 'adjust'], giveaway: true, shortage: true })
  })

  it('builds a bookmarkable hash that parses back into the screen state', () => {
    const hash = kartuStokHash({
      sku: { productId: 'p-1', variantSize: '100 ml' },
      locationKey: 'outlet:o-1',
      fromDay: '2026-01-01',
      toDay: '2026-01-31',
      label: 'Canvas Bag · 100 ml',
    })
    expect(hash.startsWith('#/inventori/stok/kartu-stok?')).toBe(true)
    const loc = parseHash(hash)
    expect(loc.path).toEqual(['inventori', 'stok', 'kartu-stok'])
    expect(parseListState(KARTU_SCHEMA, loc.query)).toEqual({
      lokasi: 'outlet:o-1', sku: 'p-1|100 ml', dari: '2026-01-01', sampai: '2026-01-31', jenis: '',
    })
    expect(rememberedSkuLabel({ productId: 'p-1', variantSize: '100 ml' })).toBe('Canvas Bag · 100 ml')
  })

  it('leaves defaults out of the URL', () => {
    const state = parseListState(KARTU_SCHEMA, {})
    expect(Object.values(serializeListState(KARTU_SCHEMA, state)).every((v) => v === undefined)).toBe(true)
  })
})
