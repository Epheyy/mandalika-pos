import { describe, expect, it } from 'vitest'
import { buildSaleOrderPayload } from './salePayload'
import { resolveSelectedSalesman, salesPickList, UNKNOWN_SALES_LABEL } from './salesPicker'

const staff = [{ id: 's1', name: 'Rina' }, { id: 's2', name: 'Dewi' }]
const users = [{ id: 'u1', displayName: 'Admin' }, { id: 'u2' }]

describe('salesPickList', () => {
  it('uses the sales staff list over users', () => {
    expect(salesPickList({ salesStaff: staff, users }, null)).toEqual(staff)
  })
  it('an empty staff list stays empty even when users exist', () => {
    expect(salesPickList({ salesStaff: [], users }, null)).toEqual([])
  })
  it('falls back to named users when the server sends no staff list', () => {
    expect(salesPickList({ users }, null)).toEqual([{ id: 'u1', name: 'Admin' }])
    expect(salesPickList({}, null)).toEqual([])
  })
  it('appends a selected salesperson who is not listed', () => {
    expect(salesPickList({ salesStaff: staff }, { id: 'old', name: 'Lama' })).toEqual([...staff, { id: 'old', name: 'Lama' }])
  })
  it('does not duplicate a selected salesperson who is listed', () => {
    expect(salesPickList({ salesStaff: staff }, { id: 's1', name: 'Rina' })).toEqual(staff)
  })
  it('an empty staff list plus a saved pick lists exactly that pick', () => {
    expect(salesPickList({ salesStaff: [] }, { id: 'old', name: 'Lama' })).toEqual([{ id: 'old', name: 'Lama' }])
  })
  it('labels an unlisted pick with a blank name', () => {
    expect(salesPickList({ salesStaff: staff }, { id: 'x', name: '  ' }).at(-1)).toEqual({ id: 'x', name: UNKNOWN_SALES_LABEL })
  })
})

describe('resolveSelectedSalesman', () => {
  const held = { id: 's1', name: 'Rina' }
  const renamed = { salesStaff: [{ id: 's1', name: 'Rina S.' }] }
  const sale = (selected: { id: string; name: string } | null) => buildSaleOrderPayload({
    orderNumber: 'N1', items: [], plan: { paymentMethod: 'cash', amountPaid: 0, lines: [] } as never, promotionMetadata: {} as never, redeemedPoints: 0, shiftId: null, quote: { quotedTotal: 0, receiptSnapshot: null } as never,
    state: { selectedCustomer: null, selectedSalesman: selected, discountRunning: 0, appliedDiscountType: 'percent', surchargeRunning: 0, appliedSurchargeType: 'percent', orderNotes: '' } as never,
  })
  it('a listed pick under a new name shows and sends the current name', () => {
    expect(salesPickList(renamed, held)).toEqual([{ id: 's1', name: 'Rina S.' }])
    const p = sale(resolveSelectedSalesman(renamed, held))
    expect(p.salesmanId).toBe('s1')
    expect(p.salesmanName).toBe('Rina S.')
  })
  it('an unlisted pick keeps its saved name; none stays null', () => {
    expect(resolveSelectedSalesman({ salesStaff: [] }, held)).toEqual(held)
    expect(sale(resolveSelectedSalesman({ salesStaff: [] }, held)).salesmanName).toBe('Rina')
    expect(resolveSelectedSalesman(renamed, null)).toBeNull()
  })
  it('a blank-named unlisted pick still sends its id', () => {
    expect(resolveSelectedSalesman({ salesStaff: [] }, { id: 'x', name: '' })).toEqual({ id: 'x', name: '' })
  })
})
