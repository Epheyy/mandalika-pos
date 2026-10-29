import { expect, it } from 'vitest'
import type { Order } from '@mandalika/api'
import { paymentBreakdown } from './metrics'

const mk = (o: Record<string, unknown>) => o as unknown as Order
const t = (method: string, amount: number) => ({ seq: 1, method, amount, tendered: amount, change: 0, synthetic: false })

it('splits a split-payment order across its methods and nets cash refunds', () => {
  const split = mk({
    status: 'partially_refunded', total: 1251000, paymentMethod: 'split',
    tenders: [t('qris', 751000), t('cash', 500000)],
    refunds: [{ id: 'r', seq: 1, scope: 'partial', amount: 100000, computedAmount: 100000, paymentMethod: 'cash', reason: 'x', items: [] }],
  })
  const legacy = mk({ status: 'completed', total: 50, paymentMethod: 'cash' })
  const rows = paymentBreakdown([split, legacy])
  expect(rows.map((r) => [r.method, r.amount])).toEqual([['qris', 751000], ['cash', 400050]])
})

it('keeps the order-method fallback when tenders are absent', () => {
  const rows = paymentBreakdown([mk({ status: 'completed', total: 70, paymentMethod: 'qris' })])
  expect(rows).toEqual([{ method: 'qris', label: 'QRIS', amount: 70 }])
})
