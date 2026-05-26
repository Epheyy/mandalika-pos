import { describe, it, expect } from 'vitest'
import { buildTandaTerima, type TandaTerimaData } from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

const fix: TandaTerimaData = {
  tandaTerimaNo: 'TT-2026-00001',
  transferNo: 'TRF-00005',
  receivedAt: new Date('2026-05-26T07:45:00+07:00'),
  receiverHeaderLines: ['MANDALIKA PMS', 'Jl. Sunset Road 88, Kuta'],
  senderName: 'Gudang Pusat',
  items: [
    { productName: 'Parfum Bunga', variant: '50ml',  sentQty: 10, receivedQty: 10, difference: 0 },
    { productName: 'Parfum Kayu',  variant: '100ml', sentQty: 5,  receivedQty: 4,  difference: -1 },
  ],
  discrepancyReason: 'Barang rusak 1 pc',
  receivedByName: 'Kasir Ani',
}
const settings = { headerText: '', footerText: '' } as ReceiptSettings

describe('buildTandaTerima', () => {
  it('renders letterhead, doc title, K/T/S table, discrepancy reason, receiver+signature', () => {
    const bytes = buildTandaTerima(fix, settings)
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text).toContain('MANDALIKA PMS')
    expect(text).toContain('Jl. Sunset Road 88, Kuta')
    expect(text).toContain('TANDA TERIMA')
    expect(text).toContain('TT-2026-00001')
    expect(text).toContain('TRF-00005')
    expect(text).toContain('Dari')
    expect(text).toContain('Gudang Pusat')
    expect(text).toContain('Krm')
    expect(text).toContain('Trm')
    expect(text).toContain('Sel')
    expect(text).toContain('Parfum Bunga')
    expect(text).toContain('Parfum Kayu')
    expect(text).toContain('Selisih')
    expect(text).toContain('Barang rusak 1 pc')
    expect(text).toContain('Diterima oleh: Kasir Ani')
    expect(text).toContain('Tanda Tangan')
  })

  it('omits Selisih block when discrepancyReason is null', () => {
    const noDiff: TandaTerimaData = {
      ...fix,
      discrepancyReason: null,
      items: fix.items.map((i) => ({ ...i, receivedQty: i.sentQty, difference: 0 })),
    }
    const text = new TextDecoder('latin1').decode(buildTandaTerima(noDiff, settings))
    expect(text).not.toContain('Selisih')
  })

  it('K/T/S header line is exactly 32 chars wide', () => {
    const text = new TextDecoder('latin1').decode(buildTandaTerima(fix, settings))
    const header = ' '.repeat(19) + 'Krm' + '  ' + 'Trm' + '  ' + 'Sel'
    expect(header.length).toBe(32)
    expect(text).toContain(header)
  })
})
