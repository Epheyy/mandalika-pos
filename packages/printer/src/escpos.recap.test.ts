import { describe, it, expect } from 'vitest'
import { buildRecap, money, pad, type RecapData } from './escpos'
import type { components } from '@mandalika/api'

type ReceiptSettings = components['schemas']['ReceiptSettings']
const txt = (u: Uint8Array) => String.fromCharCode(...u)
const settings = { headerText: 'TOKO', footerText: '' } as ReceiptSettings

describe('shift recap slip: refunds of other shifts (A06)', () => {
  const recap: RecapData = {
    title: 'Rekap Shift', outletName: 'BSD', cashierName: 'Kasir', openedAt: null, closedAt: null,
    startingCash: null, closingCash: null, methods: [{ label: 'Tunai', recorded: 275000, counted: null }],
    totalRecorded: 275000, totalCounted: null, cashIn: null, cashOut: null, gross: 0, refundTotal: 0, refundCount: 0,
    discount: 0, surcharge: 0, net: 0, tax: 0, totalSales: 275000, totalOrders: 1, generatedAt: new Date('2026-10-11T00:00:00Z'),
  }
  it('prints nothing extra when there are none', () => {
    const t = txt(buildRecap(recap, settings))
    expect(t).not.toContain('shift lain')
    expect(t).not.toContain('perlu ditinjau')
  })
  it('prints the cross-shift refund line and the parked refunds line', () => {
    const t = txt(buildRecap({ ...recap, crossShiftRefunds: 225000, parkedRefundCount: 2, parkedRefundTotal: 80000 }, settings))
    expect(t).toContain(pad('Refund transaksi shift lain', '-' + money(225000)))
    expect(t).toContain('Refund perlu ditinjau: 2')
    expect(t).toContain(money(80000))
  })
})
