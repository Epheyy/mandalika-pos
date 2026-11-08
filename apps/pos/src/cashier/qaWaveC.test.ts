import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { freshCustomer } from './CustomerProfileSheet'
import { orderAdjustmentRow, orderAdjustmentRows } from './receiptRows'

const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8')

describe('F24 orderAdjustmentRow', () => {
  const base = { subtotal: 100_000, discountAmount: 10_000, surchargeAmount: null, taxAmount: 0, total: 90_000 }
  it('is null when the lines already add up', () => {
    expect(orderAdjustmentRow(base)).toBeNull()
  })
  it('returns a negative row for the points/rounding taken off the total', () => {
    expect(orderAdjustmentRow({ ...base, total: 80_000 })).toMatchObject({ amount: -10_000, kind: 'points' })
  })
  it('includes surcharge and tax and returns a positive row when rounding went up', () => {
    const o = { subtotal: 100_000, discountAmount: 0, surchargeAmount: 5_000, taxAmount: 11_000, total: 116_300 }
    expect(orderAdjustmentRow(o)).toMatchObject({ amount: 300, kind: 'rounding' })
  })
})

describe('orderAdjustmentRows (points redemption amount)', () => {
  const o = { subtotal: 10_000, discountAmount: 0, surchargeAmount: null, taxAmount: 0, total: 9_100 }
  it('shows a Tukar poin row from the server amount and no residual when it explains the gap', () => {
    const rows = orderAdjustmentRows({ ...o, pointsRedeemed: 9, pointsRedemptionAmount: 900 })
    expect(rows).toEqual([{ key: 'points', kind: 'points', label: 'Tukar poin (9)', amount: -900 }])
  })
  it('keeps only the unexplained remainder as Pembulatan', () => {
    const rows = orderAdjustmentRows({ ...o, total: 9_050, pointsRedeemed: 9, pointsRedemptionAmount: 900 })
    expect(rows).toEqual([
      { key: 'points', kind: 'points', label: 'Tukar poin (9)', amount: -900 },
      { key: 'rounding', kind: 'rounding', label: 'Pembulatan', amount: -50 },
    ])
  })
  it('falls back to the single residual row without the field (older server or null amount)', () => {
    expect(orderAdjustmentRows(o)).toEqual([orderAdjustmentRow(o)])
    expect(orderAdjustmentRows({ ...o, pointsRedemptionAmount: null })).toEqual([orderAdjustmentRow(o)])
  })
  it('returns nothing when lines add up and nothing was redeemed', () => {
    expect(orderAdjustmentRows({ ...o, total: 10_000 })).toEqual([])
  })
})

describe('F23 freshCustomer', () => {
  const stale = { id: 'c1', name: 'Rina', phone: '1', points: 10, totalSpent: 0, visitCount: 1, createdAt: '' } as never
  it('takes the points balance from the fetched profile', () => {
    expect(freshCustomer(stale, { customer: { id: 'c1', points: 70 } }).points).toBe(70)
  })
  it('keeps the object when there is no profile or it is for another customer', () => {
    expect(freshCustomer(stale, null)).toBe(stale)
    expect(freshCustomer(stale, { customer: { id: 'c2', points: 70 } })).toBe(stale)
  })
})

describe('wave C source guards', () => {
  it('U1: the category thumb re-measures when the tablist is resized (cart column opening)', () => {
    const grid = read('./ProductGrid.tsx')
    expect(grid).toContain('tablistRef')
    expect(grid).toMatch(/new ResizeObserver\(\(\) => measure\(\)\)/)
    expect(grid).toContain('ro.observe(el)')
  })
  it('F25: the catalogue scroller clears the portrait bottom bar when the cart has items', () => {
    expect(read('./ProductGrid.tsx')).toContain("'pb-20 sm:pb-3'")
    expect(read('./CashierScreen.tsx')).toContain('clearBottomBar={derived.totalCartItems > 0}')
  })
  it('F17/F12/F26 wording', () => {
    expect(read('./HeldOrdersSheet.tsx')).toContain('Subtotal {formatRupiah(lineTotal(o))}')
    const h = read('./OrderHistoryPanel.tsx')
    expect(h).toContain('Dari (hari shift)')
    expect(h).toContain('Sampai (hari shift)')
    expect(read('./LocalReceiptsPanel.tsx')).toContain('Dicatat di tablet')
  })
})
