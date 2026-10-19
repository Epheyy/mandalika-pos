import { expect, it } from 'vitest'
import { BRAND } from '../../lib/brand'
import { breakdownRows, isNegative, moneyOrDash, refundExportParams, sharePercent } from './exportSummary'

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

it('computes shares of gross', () => {
  expect(sharePercent(50, 200)).toBe(25)
  expect(sharePercent(10, 0)).toBe(0)
})

it('refund export pages the refund-day list with the same filter', () => {
  expect(refundExportParams({ dateFrom: '2026-02-01', status: 'refunded', q: 'x' })).toEqual({
    dateFrom: '2026-02-01', status: 'refunded', q: 'x', dateBasis: 'refund',
  })
})
