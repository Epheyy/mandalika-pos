import { describe, expect, it } from 'vitest'
import type { StockMovementRow } from '@mandalika/api'
import { docRefOf } from './documentRef'

const base = { refType: 'order' } as StockMovementRow
const row = (p: Partial<StockMovementRow>): StockMovementRow => ({ ...base, ...p })

describe('docRefOf', () => {
  it('opens the adjustment request, not the applied adjustment row', () => {
    expect(docRefOf(row({ refType: 'stock_adjustment', refId: 'a', requestId: 'r', docNumber: 'ADJ-1' }), false))
      .toEqual({ type: 'adjustment', id: 'r', label: 'ADJ-1' })
    expect(docRefOf(row({ refType: 'stock_adjustment', refId: 'a' }), false)).toBeNull()
  })

  it('maps transfers, counts and receipts by ref id', () => {
    expect(docRefOf(row({ refType: 'transfer', refId: 't', refNumber: 'TRF-1' }), false)?.type).toBe('transfer')
    expect(docRefOf(row({ refType: 'stock_count', refId: 'c' }), false)?.type).toBe('count')
    expect(docRefOf(row({ refType: 'goods_receipt', refId: 'g' }), false)?.type).toBe('receipt')
  })

  it('opens orders only for users who may read them', () => {
    expect(docRefOf(row({ refType: 'order', refId: 'o', refNumber: 'INV-1' }), false)).toBeNull()
    expect(docRefOf(row({ refType: 'order', refId: 'o', refNumber: 'INV-1' }), true)).toEqual({ type: 'order', id: 'o', label: 'INV-1' })
  })

  it('leaves backfill and unknown types as text', () => {
    expect(docRefOf(row({ refType: 'backfill' }), true)).toBeNull()
    expect(docRefOf(row({ refType: 'transfer' }), true)).toBeNull()
  })
})
