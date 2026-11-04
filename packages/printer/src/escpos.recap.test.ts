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

describe('shift recap slip: unsynced and legacy refund notes', () => {
  const base = {
    title: 'Rekap Shift', outletName: 'BSD', cashierName: 'Kasir', openedAt: null, closedAt: null,
    startingCash: null, closingCash: null, methods: [], totalRecorded: 0, totalCounted: null, cashIn: null, cashOut: null,
    gross: 0, refundTotal: 0, refundCount: 0, discount: 0, surcharge: 0, net: 0, tax: 0, totalSales: 0, totalOrders: 0,
    generatedAt: new Date('2026-10-11T00:00:00Z'),
  } as RecapData
  it('prints the unsynced refunds line', () => {
    expect(txt(buildRecap({ ...base, unsyncedRefunds: 225000 }, settings))).toContain(pad('Refund belum tersinkron', '-' + money(225000)))
  })
  it('prints the "tanpa detail" note for legacy queued refunds', () => {
    const t = txt(buildRecap({ ...base, unknownRefundDetailCount: 2 }, settings))
    expect(t).toContain('tanpa detail: 2')
    expect(t).toContain('tidak dihitung')
  })
})

describe('shift recap slip: full refunds are an info line outside Kotor (CS-4)', () => {
  const base = {
    title: 'Rekap Shift', outletName: 'BSD', cashierName: 'Kasir', openedAt: null, closedAt: null,
    startingCash: null, closingCash: null, methods: [], totalRecorded: 0, totalCounted: null, cashIn: null, cashOut: null,
    gross: 200000, refundTotal: 50000, refundCount: 2, discount: 20000, surcharge: 0, net: 130000, tax: 0, totalSales: 130000, totalOrders: 1,
    generatedAt: new Date('2026-10-11T00:00:00Z'),
  } as RecapData
  it('prints the deducted line and the info line separately', () => {
    const t = txt(buildRecap({ ...base, refundFullTotal: 100000 }, settings))
    expect(t).toContain(pad('Pengembalian Kotor', '-' + money(50000)))
    expect(t).toContain('Refund penuh ' + money(100000) + ' (di luar Kotor)')
  })
  it('prints no info line without full refunds', () => {
    expect(txt(buildRecap(base, settings))).not.toContain('Refund penuh')
  })
})
