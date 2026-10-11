import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { REFUND_DONE, refundAvailability, refundGateProps } from './refundView'
import { RefundAction } from './RefundAction'

type Order = components['schemas']['Order']
const order = (over: Partial<Order> = {}) => ({ id: 'o1', status: 'completed', ...over }) as unknown as Order
const base = { canRefund: true, hasOpenShift: true, queuedOrderIds: new Set<string>() }

describe('M2: a refund this tablet already synced', () => {
  it('blocks a stale completed row with "Sudah direfund"', () => {
    expect(REFUND_DONE).toBe('Sudah direfund')
    expect(refundAvailability({ ...base, order: order(), syncedRefundOrderIds: new Set(['o1']) })).toEqual({ kind: 'blocked', reason: REFUND_DONE })
  })
  it('renders the muted line, no button', () => {
    const html = renderToStaticMarkup(createElement(RefundAction, { ...base, order: order(), syncedRefundOrderIds: new Set(['o1']), onRefund: vi.fn() }))
    expect(html).toContain('Sudah direfund')
    expect(html).not.toContain('Refund Transaksi Ini')
  })
  it('leaves other orders and absent records alone (never blocks otherwise)', () => {
    expect(refundAvailability({ ...base, order: order(), syncedRefundOrderIds: new Set(['other']) })).toEqual({ kind: 'allowed' })
    expect(refundAvailability({ ...base, order: order() })).toEqual({ kind: 'allowed' })
  })
  it('refundGateProps passes the record through', () => {
    const p = refundGateProps({ user: { role: 'admin' }, currentShift: { id: 'S' }, queuedOrderIds: new Set(), syncedRefundOrderIds: new Set(['o1']) })
    expect(p.syncedRefundOrderIds).toEqual(new Set(['o1']))
  })
})
