import { describe, expect, it } from 'vitest'
import { csvDateTime, orderTimeCsv, orderTimeLabels, pointsRedemptionCell, RECEIVED_LATE_MS } from './orderTimes'

// Built from local parts so the assertions hold in any browser/runner time zone.
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString()

describe('orderTimeLabels', () => {
  it('shows the tablet time as the sale time and the server time as a labelled second time', () => {
    const t = orderTimeLabels({ createdAt: at(9, 8, 46), clientCreatedAt: at(9, 1, 31) })
    expect(t.main).toBe('09 Nov 2026 01:31')
    expect(t.received).toBe('Diterima server 08:46')
  })

  it('names the day when the server heard on a later day', () => {
    const t = orderTimeLabels({ createdAt: at(10, 1, 0), clientCreatedAt: at(9, 23, 0) })
    expect(t.received).toBe('Diterima server 10 Nov 01:00')
  })

  it('has no second time for an online sale within the threshold', () => {
    const base = new Date(2026, 10, 9, 10, 0).getTime()
    expect(orderTimeLabels({ createdAt: new Date(base + RECEIVED_LATE_MS).toISOString(), clientCreatedAt: new Date(base).toISOString() }).received).toBeNull()
  })

  it('falls back to createdAt when clientCreatedAt is missing or null', () => {
    for (const clientCreatedAt of [undefined, null]) {
      const t = orderTimeLabels({ createdAt: at(9, 9, 5), clientCreatedAt })
      expect(t.main).toBe('09 Nov 2026 09:05')
      expect(t.received).toBeNull()
    }
  })

  it('ignores a tablet time the backend would not trust (clock fast or reset)', () => {
    expect(orderTimeLabels({ createdAt: at(9, 9, 0), clientCreatedAt: at(9, 11, 0) }).main).toBe('09 Nov 2026 09:00')
    expect(orderTimeLabels({ createdAt: at(9, 9, 0), clientCreatedAt: '2020-01-01T00:00:00Z' }).main).toBe('09 Nov 2026 09:00')
  })

  it('does not throw on an unparseable time', () => {
    expect(orderTimeLabels({ createdAt: 'bad' }).main).toBe('-')
  })
})

describe('orderTimeCsv', () => {
  it('writes explicit columns: sale time, server receive time, business day', () => {
    const row = orderTimeCsv({ createdAt: at(9, 8, 46), clientCreatedAt: at(9, 1, 31), businessDate: '2026-11-08' as never })
    expect(row).toEqual({ 'Waktu Transaksi': '2026-11-09 01:31', 'Diterima Server': '2026-11-09 08:46', 'Hari Bisnis': '2026-11-08' })
  })

  it('uses createdAt for both times when the row has no client time', () => {
    const row = orderTimeCsv({ createdAt: at(9, 9, 5) })
    expect(row['Waktu Transaksi']).toBe('2026-11-09 09:05')
    expect(row['Diterima Server']).toBe('2026-11-09 09:05')
    expect(row['Hari Bisnis']).toBe('')
  })
})

describe('csvDateTime', () => {
  it('writes yyyy-MM-dd HH:mm, the same format as the order time columns', () => {
    expect(csvDateTime(at(9, 21, 41))).toBe('2026-11-09 21:41')
  })
  it('is empty for a missing or unparsable time', () => {
    expect(csvDateTime(null)).toBe('')
    expect(csvDateTime(undefined)).toBe('')
    expect(csvDateTime('nope')).toBe('')
  })
})

describe('pointsRedemptionCell + Total reconciliation', () => {
  const recon = (o: { subtotal: number; discountAmount: number; taxAmount: number; surchargeAmount?: number | null; pointsRedeemed?: number; pointsRedemptionAmount?: number | null }) =>
    o.subtotal - o.discountAmount - Number(pointsRedemptionCell(o)) + o.taxAmount + (o.surchargeAmount ?? 0)
  it('a redemption order reconciles to Total (Subtotal 10000, Tukar Poin 900, Total 9100)', () => {
    const o = { subtotal: 10000, discountAmount: 0, taxAmount: 0, pointsRedeemed: 9, pointsRedemptionAmount: 900 }
    expect(pointsRedemptionCell(o)).toBe(900)
    expect(recon(o)).toBe(9100)
  })
  it('is empty for a legacy order with points spent but no derivable amount', () => {
    expect(pointsRedemptionCell({ pointsRedeemed: 9, pointsRedemptionAmount: null })).toBe('')
  })
  it('is 0 for a plain order', () => {
    expect(pointsRedemptionCell({ pointsRedeemed: 0, pointsRedemptionAmount: null })).toBe(0)
    expect(pointsRedemptionCell({})).toBe(0)
    expect(recon({ subtotal: 50000, discountAmount: 5000, taxAmount: 4950 })).toBe(49950)
  })
})
