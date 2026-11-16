import { describe, expect, it } from 'vitest'
import type { VoidReportRow } from '@mandalika/api'
import { VOID_CSV_HEADERS, reasonCards, tendersText, voidCsvRecords, voidCsvRow, voidStateLabel } from './voidReport'

const row = (over: Partial<VoidReportRow> = {}): VoidReportRow => ({
  orderId: 'o1', orderNumber: 'ORD-1', kind: 'void', state: 'replaced', businessDate: '2026-11-10', outletName: 'BSD', soldByName: 'Sari',
  voidedAt: '2026-11-10T05:00:00Z', voidedByName: 'Budi', deviceId: 'dev-1', source: 'backoffice', reasonCode: 'salah_metode_pembayaran',
  note: 'salah QRIS', afterClose: false, originalTotal: 150000,
  originalTenders: [{ method: 'cash', amount: 100000 }, { method: 'qris', amount: 50000 }],
  replacementOrderNumber: 'ORD-2', replacementTotal: 150000, replacementTenders: [{ method: 'qris', amount: 150000 }], correctionAmount: 0,
  countedLines: 1, ...over,
})

describe('voidStateLabel', () => {
  it('labels each state', () => {
    expect(voidStateLabel(row({ state: 'replaced' }))).toBe('diganti')
    expect(voidStateLabel(row({ state: 'awaiting_replacement' }))).toBe('menunggu pengganti')
    expect(voidStateLabel(row({ state: 'no_replacement' }))).toBe('tanpa pengganti')
    expect(voidStateLabel(row({ state: 'legacy', kind: 'legacy_import' }))).toBe('Dibatalkan (impor lama)')
  })
})

describe('voidCsvRow', () => {
  it('joins both tender lists as "cash 100.000 + qris 50.000"', () => {
    const r = voidCsvRow(row())
    expect(r[VOID_CSV_HEADERS.indexOf('Metode asli')]).toBe('cash 100.000 + qris 50.000')
    expect(r[VOID_CSV_HEADERS.indexOf('Metode pengganti')]).toBe('qris 150.000')
    expect(r).toHaveLength(VOID_CSV_HEADERS.length)
    expect(r[VOID_CSV_HEADERS.indexOf('Alasan')]).toBe('Salah metode pembayaran')
    expect(r[VOID_CSV_HEADERS.indexOf('Status')]).toBe('diganti')
  })
  it('leaves replacement cells empty for a void without one and keeps legacy rows listable', () => {
    const r = voidCsvRow(row({ state: 'no_replacement', replacementOrderNumber: undefined, replacementTotal: undefined, replacementTenders: undefined, correctionAmount: undefined }))
    expect(r[VOID_CSV_HEADERS.indexOf('No. pengganti')]).toBe('')
    expect(r[VOID_CSV_HEADERS.indexOf('Total pengganti')]).toBe('')
    expect(r[VOID_CSV_HEADERS.indexOf('Metode pengganti')]).toBe('')
    expect(voidCsvRow(row({ kind: 'legacy_import', state: 'legacy', reasonCode: undefined, voidedAt: undefined }))[VOID_CSV_HEADERS.indexOf('Alasan')]).toBe('')
  })
  it('records are keyed by header', () => {
    expect(Object.keys(voidCsvRecords([row()])[0]!)).toEqual([...VOID_CSV_HEADERS])
  })
  it('tendersText of nothing is empty', () => { expect(tendersText(undefined)).toBe('') })
})

describe('reasonCards', () => {
  it('reason summary lists each reason with its count', () => {
    const cards = reasonCards([
      { reasonCode: 'transaksi_ganda', voids: 1, originalTotal: 50000 },
      { reasonCode: 'salah_metode_pembayaran', voids: 2, originalTotal: 300000 },
    ])
    expect(cards.map((c) => [c.label, c.voids, c.originalTotal])).toEqual([
      ['Salah metode pembayaran', 2, 300000],
      ['Transaksi ganda', 1, 50000],
    ])
    expect(reasonCards(undefined)).toEqual([])
  })
})
