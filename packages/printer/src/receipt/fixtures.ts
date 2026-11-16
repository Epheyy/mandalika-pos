// Test fixtures shared by the golden and differential tests. Not exported from the package.

import type { components } from '@mandalika/api'
import type { ReceiptData } from './data'
import type { VoidSlipData } from './slips'
import type { RecapData, TandaTerimaData } from '../escpos'

export type ReceiptSettings = components['schemas']['ReceiptSettings']

export const FIXED_DATE = new Date('2026-05-29T03:04:00Z')

const plain: ReceiptData = {
  orderRef: 'MND-100', pending: false, dateTime: FIXED_DATE,
  lines: [{ name: 'Parfum Bunga', variant: '50ml', qty: 2, unitPrice: 150000, amount: 300000 }],
  subtotal: 300000, discountAmount: 0, taxAmount: 0, total: 300000,
  paymentLabel: 'Tunai', amountPaid: 350000, change: 50000,
  customerName: null, customerPhone: null, cashierName: 'Sari',
}

const itemised: ReceiptData = {
  ...plain, orderRef: 'MND-101',
  lines: [
    { name: 'Parfum Bunga', variant: '50ml', qty: 1, unitPrice: 150000, amount: 150000 },
    { name: 'Hadiah Sampel', qty: 1, unitPrice: 0, amount: 0, isReward: true, rewardLabel: 'Promo Mei' },
  ],
  subtotal: 150000, discountAmount: 40000,
  discounts: [
    { label: 'Promo Gajian', amount: 10000 },
    { label: 'Kode MEI25', amount: 15000 },
    { label: 'Diskon manual untuk pelanggan setia yang sangat lama', amount: 15000 },
    { label: 'Nol', amount: 0 },
  ],
  surcharge: 2000, pointsRedeemed: { points: 50, amount: 5000 }, rounding: -300, taxAmount: 11000, total: 112700,
  paymentLabel: 'Tunai', amountPaid: 120000, change: 7300,
  customerName: 'Budi Santoso', customerPhone: '08123456789',
}

const preC1: ReceiptData = { ...plain, orderRef: 'MND-102', discountAmount: 25000, taxAmount: 5000, total: 280000, subtotal: 300000 }

const split: ReceiptData = {
  ...plain, orderRef: 'MND-103',
  lines: [
    { name: 'Gratis Botol', qty: 1, unitPrice: 20000, amount: 0, isReward: true },
    { name: 'Parfum Melati', variant: '30ml', qty: 3, unitPrice: 99000, amount: 297000 },
  ],
  subtotal: 297000, total: 297000,
  tenders: [
    { label: 'Tunai', amount: 100000 },
    { label: 'QRIS', amount: 150000, reference: 'QR-20260529-ABCDEF-123456' },
    { label: 'Debit BCA', amount: 47000, reference: '1234' },
  ],
  paymentLabel: 'Split', amountPaid: 297000, change: 0,
}

const bundle: ReceiptData = {
  ...plain, orderRef: 'MND-104', pending: true,
  lines: [
    {
      name: 'CHAMPION bundle', qty: 1, unitPrice: 485000, amount: 400000,
      pieces: ['2ml PI · HOLY SWEET', '2ml Nama Produk Yang Sangat Panjang Sekali Melebihi Kertas', 'Botol'],
      lineDiscount: { label: 'Diskon Bundle', amount: 85000 },
    },
    { name: 'Nama barang yang sangat panjang sekali sampai harus dipotong di baris kedua ya', variant: 'Ukuran besar sekali sekali sekali', qty: 12, unitPrice: 1000, amount: 12000 },
  ],
  subtotal: 412000, total: 412000, amountPaid: 412000, change: 0, paymentLabel: 'QRIS',
}

const replacement: ReceiptData = {
  ...plain, orderRef: 'MND-105', replacesOrderRef: 'MND-100', correctionAmount: -15000, total: 285000, amountPaid: 300000, change: 15000,
  customerName: 'Budi Santoso',
}

export interface ReceiptCase {
  name: string
  data: ReceiptData
  settings: ReceiptSettings
  reprint: boolean
}

const s = (o: Partial<ReceiptSettings>): ReceiptSettings => o as ReceiptSettings

/** The six receipt goldens: one hex file each in __golden__/. */
export const RECEIPT_CASES: ReceiptCase[] = [
  { name: 'plain', data: plain, settings: s({ headerText: 'TOKO MANDALIKA', footerText: 'Terima kasih' }), reprint: false },
  { name: 'itemised-c1', data: itemised, settings: s({ headerText: 'Mandalika', footerText: 'Barang tidak dapat ditukar', showTax: true, showCashier: true, showCustomerPhone: true }), reprint: false },
  { name: 'pre-c1', data: preC1, settings: s({ headerText: '', footerText: 'Sampai jumpa', showTax: true }), reprint: false },
  { name: 'split-tender', data: split, settings: s({ headerText: 'Flamboyan', footerText: '', showChange: false, showOrderNumber: false }), reprint: false },
  { name: 'bundle-58mm', data: bundle, settings: s({ headerText: 'Performance Perfume', footerText: 'Terima kasih' }), reprint: false },
  { name: 'void-replacement-reprint', data: replacement, settings: s({ headerText: 'TOKO', footerText: 'Terima kasih', showCashier: true }), reprint: true },
]

/** Data cases (no settings) for the differential matrix. */
export const DATA_CASES: Record<string, ReceiptData> = { plain, itemised, preC1, split, bundle, replacement }

export const RECAP: RecapData = {
  title: 'REKAP SHIFT', outletName: 'Outlet Grand Indonesia', cashierName: 'Sari',
  openedAt: new Date('2026-05-29T01:00:00Z'), closedAt: new Date('2026-05-29T09:00:00Z'),
  startingCash: 500000, closingCash: 1250000,
  methods: [
    { label: 'Tunai', recorded: 750000, counted: 745000 },
    { label: 'QRIS', recorded: 400000, counted: null },
  ],
  totalRecorded: 1150000, totalCounted: 745000, cashIn: 20000, cashOut: 10000,
  crossShiftRefunds: 15000, unsyncedRefunds: 5000, unknownRefundDetailCount: 1, parkedRefundCount: 1, parkedRefundTotal: 30000,
  gross: 1300000, refundTotal: 40000, refundFullTotal: 10000, refundCount: 2, discount: 60000, surcharge: 2000,
  net: 1202000, tax: 12000, totalSales: 1214000, totalOrders: 9, generatedAt: new Date('2026-05-29T09:05:00Z'),
}

export const TANDA_TERIMA: TandaTerimaData = {
  tandaTerimaNo: 'TT-2026-00001', transferNo: 'TRF-00005', receivedAt: new Date('2026-05-29T04:00:00Z'),
  receiverHeaderLines: ['Mandalika GI', 'Jl. Thamrin No. 1', '021-555'],
  senderName: 'Gudang Pusat',
  items: [
    { productName: 'Parfum Bunga', variant: '50ml', sentQty: 10, receivedQty: 9, difference: -1 },
    { productName: 'Parfum Melati Yang Namanya Panjang Sekali Sampai Kepotong', variant: '30ml Edisi Spesial Banget', sentQty: 5, receivedQty: 6, difference: 1 },
  ],
  discrepancyReason: 'Satu botol pecah', receivedByName: 'Sari',
}

export const VOID_SLIP: VoidSlipData = {
  orderRef: 'MND-100', total: 300000, reasonLabel: 'Salah barang', note: 'Pelanggan minta ganti ukuran café · besar',
  voidedBy: 'Sari', dateTime: '29/05/26 10.00', replacementRef: 'MND-105',
}
