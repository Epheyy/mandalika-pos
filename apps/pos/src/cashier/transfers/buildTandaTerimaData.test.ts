import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { buildTandaTerimaData } from './buildTandaTerimaData'

type Transfer = components['schemas']['Transfer']

const baseTransfer = {
  id: 't1',
  transferNo: 'TRF-00005',
  suratJalanNo: 'SJ-2026-00001',
  tandaTerimaNo: 'TT-2026-00001',
  status: 'completed' as const,
  source: { kind: 'warehouse' as const, id: 'w', name: 'Gudang Pusat' },
  dest:   { kind: 'outlet'    as const, id: 'o', name: 'Mandalika PMS' },
  receiverLetterhead: {
    locationName: 'Mandalika PMS',
    brandName: 'Mandalika POS',
    addressLines: ['Jl. Sunset 88', 'Kuta, Bali'],
    phone: '0812-yyyy',
    npwp: null,
    logoUrl: null,
  },
  senderLetterhead: null,
  items: [
    { productId: 'p1', productName: 'Parfum Bunga', variantSize: '50ml', sku: 'PB-50', sentQty: 10, receivedQty: 8,  difference: -2 },
    { productId: 'p2', productName: 'Parfum Kayu',  variantSize: '100ml', sku: 'PK-100', sentQty: 5, receivedQty: 5, difference: 0  },
  ],
  note: null,
  discrepancyReason: 'Barang rusak 2 pc',
  receivedAt: '2026-05-26T07:45:00Z',
  sentAt: '2026-05-26T07:30:00Z',
  cancelledAt: null,
  createdAt: '2026-05-26T07:00:00Z',
} as unknown as Transfer

describe('buildTandaTerimaData', () => {
  it('maps Transfer + cashier name → TandaTerimaData', () => {
    const d = buildTandaTerimaData(baseTransfer, 'Kasir Ani')
    expect(d.tandaTerimaNo).toBe('TT-2026-00001')
    expect(d.transferNo).toBe('TRF-00005')
    expect(d.senderName).toBe('Gudang Pusat')
    expect(d.receiverHeaderLines[0]).toBe('Mandalika POS')   // brandName takes priority
    expect(d.receiverHeaderLines).toContain('Jl. Sunset 88')
    expect(d.receiverHeaderLines).toContain('0812-yyyy')
    expect(d.items[0]).toEqual({
      productName: 'Parfum Bunga', variant: '50ml',
      sentQty: 10, receivedQty: 8, difference: -2,
    })
    expect(d.discrepancyReason).toBe('Barang rusak 2 pc')
    expect(d.receivedByName).toBe('Kasir Ani')
  })

  it('falls back to locationName when brandName is null', () => {
    const t2 = {
      ...baseTransfer,
      receiverLetterhead: { ...baseTransfer.receiverLetterhead!, brandName: null },
    } as Transfer
    const d = buildTandaTerimaData(t2, 'X')
    expect(d.receiverHeaderLines[0]).toBe('Mandalika PMS')
  })

  it('falls back to dest.name when entire receiverLetterhead is null', () => {
    // Deliberate legacy null outside the generated optional-only field contract.
    const t2 = { ...baseTransfer, receiverLetterhead: null } as unknown as Transfer
    const d = buildTandaTerimaData(t2, 'X')
    expect(d.receiverHeaderLines[0]).toBe('Mandalika PMS')
  })

  it('returns null for empty/whitespace discrepancyReason', () => {
    expect(buildTandaTerimaData({ ...baseTransfer, discrepancyReason: '' } as Transfer, 'X').discrepancyReason).toBeNull()
    expect(buildTandaTerimaData({ ...baseTransfer, discrepancyReason: '   ' } as Transfer, 'X').discrepancyReason).toBeNull()
  })

  it('defaults receivedQty + difference when fields are null', () => {
    const t2 = {
      ...baseTransfer,
      items: [{ ...baseTransfer.items[0], receivedQty: null, difference: null }],
    } as Transfer
    const d = buildTandaTerimaData(t2, 'X')
    expect(d.items[0].receivedQty).toBe(10)   // falls back to sentQty
    expect(d.items[0].difference).toBe(0)
  })
})
