// The starting blocks of a new template (the mockup's order) and the sample sale the designer previews.

import type { ReceiptData } from './data'
import type { ReceiptBlock } from './layout'

export const NEW_TEMPLATE_BLOCKS: ReceiptBlock[] = [
  {
    id: 'header', type: 'header', enabled: true, text: '', size: 'large',
    showOutletName: true, showOutletAddress: true, showOutletPhone: true,
  },
  { id: 'transaction', type: 'transaction', enabled: true, fields: ['orderNumber', 'date', 'cashier', 'customerName', 'customerPhone'], style: 'columns' },
  { id: 'divider-1', type: 'divider', enabled: true },
  { id: 'items', type: 'items', enabled: true },
  { id: 'divider-2', type: 'divider', enabled: true },
  { id: 'totals', type: 'totals', enabled: true, showSubtotal: true, showDiscount: true, showTax: true },
  { id: 'payment', type: 'payment', enabled: true },
  { id: 'divider-3', type: 'divider', enabled: true },
  { id: 'points', type: 'points', enabled: true },
  { id: 'thanks', type: 'text', enabled: true, text: 'Terima kasih!', align: 'center', bold: false, size: 'normal' },
]

/** The mockup sale: a bundle with three pieces and a bundle discount, QRIS, and member points. */
export const SAMPLE_RECEIPT: ReceiptData = {
  orderRef: 'MND-000123', pending: false, dateTime: new Date('2026-11-12T05:30:00Z'),
  lines: [
    {
      name: 'CHAMPION', qty: 1, unitPrice: 485000, amount: 400000,
      pieces: ['2ml PI · HOLY SWEET', '2ml PI · ROYAL OUD', '2ml PI · BLUE MUSK'],
      lineDiscount: { label: 'Diskon Bundle', amount: 85000 },
    },
    { name: 'Parfum Melati', variant: '30ml', qty: 2, unitPrice: 200000, amount: 400000 },
  ],
  subtotal: 800000, discountAmount: 0, taxAmount: 0, total: 800000,
  paymentLabel: 'QRIS', amountPaid: 800000, change: 0,
  customerName: 'Budi Santoso', customerPhone: '08123456789', cashierName: 'Sari',
  outlet: { name: 'Outlet Grand Indonesia', address: 'Jl. M.H. Thamrin No. 1, Jakarta Pusat', phone: '021-5551234' },
  points: { earned: 80, balance: 1240 },
}
