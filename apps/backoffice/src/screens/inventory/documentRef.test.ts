import { describe, expect, it } from 'vitest'
import type { StockMovementRow } from '@mandalika/api'
import { docRefOf, refundLabel } from './documentRef'

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

describe('refund rows', () => {
  const refund = (p: Partial<StockMovementRow>) => row({ kind: 'refund', refType: 'order', refId: 'o', refNumber: 'INV-1', ...p })

  it('labels the document Refund ke-N from refundSeq (a legacy whole refund is seq 1)', () => {
    expect(refundLabel(refund({ refundSeq: 2 }))).toBe('INV-1 · Refund ke-2')
    expect(refundLabel(refund({ refundSeq: 1 }))).toBe('INV-1 · Refund ke-1')
    expect(refundLabel(refund({ refundSeq: 2, refNumber: undefined }))).toBe('Refund ke-2')
    expect(refundLabel(refund({}))).toBe('INV-1')
    expect(refundLabel(refund({ refNumber: undefined }))).toBe('Refund')
  })

  it('opens the refund (by order id and seq) only for users who may read orders', () => {
    expect(docRefOf(refund({ refundSeq: 2 }), true)).toEqual({ type: 'refund', id: 'o', seq: 2, label: 'INV-1 · Refund ke-2' })
    expect(docRefOf(refund({ refundSeq: 2 }), false)).toBeNull()
  })

  it('leaves non-refund order rows as order documents', () => {
    expect(docRefOf(row({ kind: 'sale', refType: 'order', refId: 'o', refNumber: 'INV-1' }), true)?.type).toBe('order')
  })
})
