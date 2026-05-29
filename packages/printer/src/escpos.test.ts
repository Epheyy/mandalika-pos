import { describe, it, expect } from 'vitest'
import {
  buildReceipt,
  buildTandaTerima,
  type ReceiptData,
  type TandaTerimaData,
} from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']

const txt = (u: Uint8Array) => String.fromCharCode(...u)
const MARK = '*** CETAK ULANG (REPRINT) ***'
const count = (s: string) => s.split(MARK).length - 1

const settings = { headerText: 'TOKO', footerText: '' } as ReceiptSettings

const receipt: ReceiptData = {
  orderRef: 'T1',
  pending: false,
  dateTime: new Date('2026-05-29T00:00:00Z'),
  lines: [{ name: 'Item', qty: 1, unitPrice: 1000, amount: 1000 }],
  subtotal: 1000,
  discountAmount: 0,
  taxAmount: 0,
  total: 1000,
  paymentLabel: 'Tunai',
  amountPaid: 1000,
  change: 0,
  customerName: null,
  customerPhone: null,
  cashierName: 'Kasir',
}

const tandaTerima: TandaTerimaData = {
  tandaTerimaNo: 'TT-2026-00001',
  transferNo: 'TRF-00005',
  receivedAt: new Date('2026-05-26T07:45:00+07:00'),
  receiverHeaderLines: ['MANDALIKA PMS', 'Jl. Sunset Road 88, Kuta'],
  senderName: 'Gudang Pusat',
  items: [
    { productName: 'Parfum Bunga', variant: '50ml', sentQty: 10, receivedQty: 10, difference: 0 },
  ],
  discrepancyReason: null,
  receivedByName: 'Kasir Ani',
}

describe('REPRINT marker (receipt)', () => {
  it('absent by default', () => {
    expect(txt(buildReceipt(receipt, settings)).includes(MARK)).toBe(false)
  })
  it('present twice when reprint', () => {
    expect(count(txt(buildReceipt(receipt, settings, true)))).toBe(2)
  })
})

describe('REPRINT marker (tanda terima)', () => {
  it('absent by default', () => {
    expect(txt(buildTandaTerima(tandaTerima, settings)).includes(MARK)).toBe(false)
  })
  it('present twice when reprint', () => {
    expect(count(txt(buildTandaTerima(tandaTerima, settings, true)))).toBe(2)
  })
})
