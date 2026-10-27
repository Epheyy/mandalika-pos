import { describe, expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { BRAND } from '../../lib/brand'
import { breakdownRows, canExportRefunds, hasRefundBasis, isNegative, moneyOrDash, refundCsvFields, refundExportParams, sharePercent } from './exportSummary'

it('renders a negative net with a minus sign and flags it', () => {
  expect(BRAND.currency.format(-100)).toContain('-')
  expect(moneyOrDash(-100, BRAND.currency.format)).toContain('-')
  expect(isNegative(-100)).toBe(true)
  expect(isNegative(0)).toBe(false)
  expect(isNegative(undefined)).toBe(false)
})

it('shows a dash, never zero, for a field an older backend did not send', () => {
  expect(moneyOrDash(undefined, BRAND.currency.format)).toBe('–')
  expect(moneyOrDash(0, BRAND.currency.format)).not.toBe('–')
})

it('builds the breakdown from the union of gross and refund methods', () => {
  const rows = breakdownRows({ grossByPaymentMethod: { cash: 130, qris: 200 }, refundsByPaymentMethod: { cash: 30, card: 10 } })
  expect(rows).toEqual([
    { method: 'cash', gross: 130, refunds: 30, net: 100 },
    { method: 'qris', gross: 200, refunds: 0, net: 200 },
    { method: 'card', gross: 0, refunds: 10, net: -10 },
  ])
  expect(breakdownRows({})).toEqual([])
})

it('guards the refund basis on grossSales, not totalRefunds (old backend)', () => {
  expect(hasRefundBasis(undefined)).toBe(false)
  expect(hasRefundBasis(null)).toBe(false)
  expect(hasRefundBasis({} as { grossSales: number })).toBe(false)
  expect(hasRefundBasis({ grossSales: 0 })).toBe(true)
})

it('disables the refund CSV without a refund basis or without refunds', () => {
  expect(canExportRefunds({ refundedOrders: 3 } as { grossSales: number; refundedOrders: number })).toBe(false)
  expect(canExportRefunds({ grossSales: 100, refundedOrders: 0 })).toBe(false)
  expect(canExportRefunds({ grossSales: 100, refundedOrders: 2 })).toBe(true)
  expect(canExportRefunds(null)).toBe(false)
})

it('computes shares of gross', () => {
  expect(sharePercent(50, 200)).toBe(25)
  expect(sharePercent(10, 0)).toBe(0)
})

it('refund export pages the refund-day list with the same filter', () => {
  expect(refundExportParams({ dateFrom: '2026-02-01', status: 'refunded', q: 'x' })).toEqual({
    dateFrom: '2026-02-01', status: 'refunded', q: 'x', dateBasis: 'refund',
  })
})

describe('refundCsvFields (C4a)', () => {
  const base = { total: 100, status: 'completed' } as unknown as Order

  it('is empty for a completed order', () => {
    expect(refundCsvFields(base).amount).toBe('')
  })

  it('keeps the old-backend output: total for a refunded order, order-level columns', () => {
    const o = { ...base, status: 'refunded', refundedAt: '2026-03-02T05:00:00Z', refundBusinessDate: '2026-03-02', refundReason: 'rusak' } as unknown as Order
    expect(refundCsvFields(o)).toEqual({ amount: 100, refundedAt: '2026-03-02T05:00:00Z', refundBusinessDate: '2026-03-02', reason: 'rusak' })
  })

  it('fills a partially refunded order from the latest refunds[] entry and refundedAmount', () => {
    const o = {
      ...base, status: 'partially_refunded', refundedAmount: 50, refundedAt: null, refundBusinessDate: null, refundReason: null,
      refunds: [
        { refundedAt: '2026-03-02T05:00:00Z', refundBusinessDate: '2026-03-02', reason: 'a' },
        { refundedAt: '2026-03-05T05:00:00Z', refundBusinessDate: '2026-03-05', reason: 'b' },
      ],
    } as unknown as Order
    expect(refundCsvFields(o)).toEqual({ amount: 50, refundedAt: '2026-03-05T05:00:00Z', refundBusinessDate: '2026-03-05', reason: 'b' })
  })
})
