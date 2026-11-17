// Test helper (not exported from the package): the largest receipt the limits allow. It sizes the drain budget
// (`MAX_RECEIPT_PAYLOAD_BYTES` in linkChoice.ts) so a logo-heavy slip with five copies is not cut off.

import type { ReceiptData } from './data'
import type { ReceiptBlock, ReceiptLayout } from './layout'
import { RECEIPT_LIMITS } from './validate'

const bytesToBase64 = (b: Uint8Array): string => {
  let bin = ''
  for (const v of b) bin += String.fromCharCode(v)
  return btoa(bin)
}

/** Two logos that together use the whole raster allowance (2 x 384x120 dots = 11,520 bytes). */
function logo(id: string): ReceiptBlock {
  const width = 384, height = 120
  const data = bytesToBase64(new Uint8Array((width / 8) * height).fill(0xaa))
  return { id, type: 'image', enabled: true, image: { width, height, data }, align: 'center' }
}

const text = (id: string, n: number): ReceiptBlock => ({
  id, type: 'text', enabled: true, text: 'Terima kasih sudah belanja. '.repeat(10).slice(0, n), align: 'left', bold: true, size: 'normal',
})

/** 30 blocks: 2 logos at the raster cap, 2 QR codes of 300 characters, text filling the 1,500-character
 *  allowance, every transaction field in both styles, and dividers up to the block limit. */
export function worstCaseLayout(): ReceiptLayout {
  const url = 'https://mandalikaperfume.co.id/' + 'a'.repeat(RECEIPT_LIMITS.urlMax - 'https://mandalikaperfume.co.id/'.length)
  const fields = ['orderNumber', 'date', 'cashier', 'customerName', 'customerPhone'] as const
  const blocks: ReceiptBlock[] = [
    logo('logo-1'), logo('logo-2'),
    { id: 'header', type: 'header', enabled: true, text: 'H'.repeat(RECEIPT_LIMITS.titleMax), size: 'large', showOutletName: true, showOutletAddress: true, showOutletPhone: true },
    { id: 'tx-columns', type: 'transaction', enabled: true, fields: [...fields], style: 'columns' },
    { id: 'tx-inline', type: 'transaction', enabled: true, fields: [...fields], style: 'inline' },
    { id: 'items', type: 'items', enabled: true },
    { id: 'totals', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
    { id: 'payment', type: 'payment', enabled: true },
    { id: 'points', type: 'points', enabled: true },
    { id: 'qr-1', type: 'qr', enabled: true, url, align: 'center' },
    { id: 'qr-2', type: 'qr', enabled: true, url, align: 'center' },
  ]
  // 1,500 - 64 (header) = 1,436 text characters over 7 blocks.
  const share = Math.floor((RECEIPT_LIMITS.totalTextMax - RECEIPT_LIMITS.titleMax) / 7)
  for (let i = 0; i < 7; i++) blocks.push(text(`text-${i}`, share))
  for (let i = 0; blocks.length < RECEIPT_LIMITS.blocksMax; i++) blocks.push({ id: `divider-${i}`, type: 'divider', enabled: true })
  return { paperWidth: 58, blocks }
}

/** 60 lines with 70-character names, 6 discount rows and 3 tenders with references. */
export const WORST_CASE_SALE: ReceiptData = {
  orderRef: 'OFFLINE-0123456789abcdef0123456789', pending: false, dateTime: new Date('2026-11-12T05:30:00Z'),
  lines: Array.from({ length: 60 }, (_, i) => ({
    name: `Parfum ${i} `.padEnd(70, 'N'), variant: 'V'.repeat(30), qty: 12, unitPrice: 1999999, amount: 23999988,
    pieces: ['2ml PI HOLY SWEET', '2ml PI ROYAL OUD'], lineDiscount: { label: 'Diskon bundle spesial', amount: 85000 },
  })),
  subtotal: 1439999280,
  discounts: Array.from({ length: 6 }, (_, i) => ({ label: `Diskon promo nomor ${i} `.padEnd(50, 'x'), amount: 1000 })),
  discountAmount: 6000, taxAmount: 11000, surcharge: 2000, rounding: -300, correctionAmount: 5000,
  pointsRedeemed: { points: 5000, amount: 50000 },
  total: 1439999280,
  tenders: Array.from({ length: 3 }, (_, i) => ({ label: `Kartu kredit bank ${i}`, amount: 479999760, reference: 'R'.repeat(40) })),
  paymentLabel: 'Campuran', amountPaid: 1439999280, change: 1234567,
  customerName: 'C'.repeat(60), customerPhone: '0812' + '3'.repeat(30), cashierName: 'K'.repeat(40),
  replacesOrderRef: 'MND-' + 'R'.repeat(40),
  outlet: { name: 'Outlet ' + 'O'.repeat(50), address: 'A'.repeat(120), phone: '021-' + '5'.repeat(30) },
  points: { earned: 123456, balance: 9999999 },
}
