import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { CASH_REFUNDS_PAID_HEADER, cashRefundsPaidCell, refundedByLine } from './refundDisplay'

type Shift = components['schemas']['Shift']
type Order = components['schemas']['Order']

describe('shift report: Refund dibayar (Tunai)', () => {
  const fmt = (n: number) => `Rp ${n}`
  it('uses the exact column header', () => {
    expect(CASH_REFUNDS_PAID_HEADER).toBe('Refund dibayar (Tunai)')
  })
  it('shows the amount, including a real zero', () => {
    expect(cashRefundsPaidCell({ cashRefundsPaid: 125000 } as Shift, fmt)).toBe('Rp 125000')
    expect(cashRefundsPaidCell({ cashRefundsPaid: 0 } as Shift, fmt)).toBe('Rp 0')
  })
  it('shows a dash when the server did not send it (null before 0047, or undefined)', () => {
    expect(cashRefundsPaidCell({ cashRefundsPaid: null } as Shift, fmt)).toBe('—')
    expect(cashRefundsPaidCell({} as Shift, fmt)).toBe('—')
  })
  it('exports the raw number in CSV, a dash when unknown', () => {
    expect(cashRefundsPaidCell({ cashRefundsPaid: 125000 } as Shift)).toBe(125000)
    expect(cashRefundsPaidCell({ cashRefundsPaid: null } as Shift)).toBe('—')
  })
})

describe('order refund line: oleh {refundedByName}', () => {
  it('names who refunded when known', () => {
    expect(refundedByLine({ refundedByName: 'Ni Luh' } as Order)).toBe('oleh Ni Luh')
  })
  it('is absent for old refunds and blank names', () => {
    expect(refundedByLine({ refundedByName: null } as Order)).toBeNull()
    expect(refundedByLine({ refundedByName: '  ' } as Order)).toBeNull()
    expect(refundedByLine({} as Order)).toBeNull()
  })
})
