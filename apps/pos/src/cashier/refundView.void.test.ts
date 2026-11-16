import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { REFUND_VOIDED, refundAvailability, refundGateProps } from './refundView'
import { localSaleRef } from './localReceipts'

type Order = components['schemas']['Order']

const order = (over: Partial<Order> = {}): Order => ({ id: 'o1', orderNumber: 'BSD-1', status: 'completed', total: 1000, paymentMethod: 'cash', items: [], ...over }) as Order
const base = { order: order(), canRefund: true, hasOpenShift: true, queuedOrderIds: new Set<string>() }

describe('the refund gate sees voids', () => {
  it('blocks a sale with a queued, parked or acknowledged void, by server id or sale uuid', () => {
    expect(refundAvailability({ ...base, voidedOrderIds: new Set(['o1']) })).toEqual({ kind: 'blocked', reason: REFUND_VOIDED })
    const local = { ...base, sale: { orderUuid: 'u1', serverOrderId: 'o1' }, order: order({ id: 'u1' }) }
    expect(refundAvailability({ ...local, voidedOrderIds: new Set(['o1']) })).toEqual({ kind: 'blocked', reason: REFUND_VOIDED })
    expect(refundAvailability({ ...local, voidedOrderIds: new Set(['u1']) })).toEqual({ kind: 'blocked', reason: REFUND_VOIDED })
    expect(refundAvailability({ ...base, voidedOrderIds: new Set(['other']) })).toEqual({ kind: 'allowed' })
  })

  it('blocks a local receipt flagged voidQueued or voided, and a cancelled order that carries a void', () => {
    expect(localSaleRef({ orderUuid: 'u1', voidQueued: true })).toEqual({ orderUuid: 'u1', voided: true })
    expect(localSaleRef({ orderUuid: 'u1', serverOrderId: 's1', voided: true })).toEqual({ orderUuid: 'u1', serverOrderId: 's1', voided: true })
    expect(localSaleRef({ orderUuid: 'u1' })).toEqual({ orderUuid: 'u1' })
    expect(refundAvailability({ ...base, sale: localSaleRef({ orderUuid: 'u1', voided: true }) })).toEqual({ kind: 'blocked', reason: 'Transaksi sudah dibatalkan' })
    const cancelled = order({ status: 'cancelled', void: { mode: 'none' } as Order['void'] })
    expect(refundAvailability({ ...base, order: cancelled })).toEqual({ kind: 'blocked', reason: REFUND_VOIDED })
    // A cancelled imported order without a void stays hidden.
    expect(refundAvailability({ ...base, order: order({ status: 'cancelled' }) })).toEqual({ kind: 'hidden' })
  })

  it('refundGateProps carries the voided ids to both panels', () => {
    const ids = new Set(['o1'])
    expect(refundGateProps({ user: null, currentShift: null, queuedOrderIds: new Set(), voidedOrderIds: ids }).voidedOrderIds).toBe(ids)
  })
})
