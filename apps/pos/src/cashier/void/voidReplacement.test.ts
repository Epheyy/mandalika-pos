import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { planHeldRestore } from '../heldRestore'
import {
  heldOrderFromVoidedOrder, initialReplacementTenders, lockedReplacementTenders, replacementCorrection, type VoidDraft,
} from './voidReplacement'

type Order = components['schemas']['Order']

const draft = (over: Partial<VoidDraft> = {}): VoidDraft => ({
  orderId: 'ord1', orderNumber: 'BSD-1', originalTotal: 100000, originalTenders: [{ method: 'cash', amount: 100000 }],
  reason: 'salah_barang', note: '', stockChoices: {}, shiftId: 's1', amountsLocked: false, kind: 'void_and_replace', ...over,
})

describe('replacementCorrection', () => {
  it('adjust gives original_total and the gap', () => {
    expect(replacementCorrection(draft(), 90000, 'adjust')).toEqual({ correctionTarget: 'original_total', correction: 10000 })
    expect(replacementCorrection(draft(), 120000, 'adjust')).toEqual({ correctionTarget: 'original_total', correction: -20000 })
  })
  it('settle gives no correction on an unlocked draft', () => {
    expect(replacementCorrection(draft(), 90000, 'settle')).toEqual({ correction: 0 })
  })
  it('locked drafts always adjust', () => {
    expect(replacementCorrection(draft({ amountsLocked: true }), 90000, 'settle')).toEqual({ correctionTarget: 'original_total', correction: 10000 })
  })
})

describe('tenders', () => {
  it('starts from the original applied tenders (a copy)', () => {
    const d = draft({ originalTenders: [{ method: 'qris', amount: 60000, reference: 'R' }, { method: 'cash', amount: 40000 }] })
    const t = initialReplacementTenders(d)
    expect(t).toEqual(d.originalTenders)
    expect(t).not.toBe(d.originalTenders)
  })
  it('lockedReplacementTenders trims cash change so lines sum to the amount received', () => {
    const cash = [{ id: 'cash', label: 'Tunai', isCash: true }]
    expect(lockedReplacementTenders([{ method: 'cash', amount: 150000 }], 100000, cash)).toEqual([{ method: 'cash', amount: 100000 }])
    expect(lockedReplacementTenders([{ method: 'qris', amount: 60000 }, { method: 'cash', amount: 100000 }], 100000, cash))
      .toEqual([{ method: 'qris', amount: 60000 }, { method: 'cash', amount: 40000 }])
    expect(lockedReplacementTenders([{ method: 'qris', amount: 100000 }], 100000, cash)).toEqual([{ method: 'qris', amount: 100000 }])
  })
})

describe('heldOrderFromVoidedOrder', () => {
  const bundle = (role: 'large' | 'atomizer' | 'vial', productId: string): Order['items'][number] => ({
    productId, productName: role, variantSize: role === 'large' ? '120ml' : '2ml', price: 100, quantity: 1, subtotal: 100,
    isBundle: true, bundleGroup: 1, bundleRole: role, bundlePrice: 300, bundleBasisPrice: 100, bundleLine: 'EXTRAIT DE PARFUM', bundleSize: '120ml',
    id: 'row', lineNo: 1, netAmount: 100, refundGroup: 'bundle:x:1', refundedQty: 0,
  } as Order['items'][number])
  const order = {
    id: 'ord1', orderNumber: 'BSD-1', customerId: 'cu1', customerName: 'Sari', salesmanId: 'sm1', salesmanName: 'Budi', notes: 'cat',
    discountType: 'percentage', discountValue: 10, surchargeType: 'fixed', surchargeValue: 5000, discountCode: 'HEMAT',
    pointsRedeemed: 0,
    items: [
      bundle('large', 'p1'), bundle('atomizer', 'p2'), bundle('vial', 'p3'),
      { productId: 'p4', productName: 'D', variantSize: '30ml', price: 50, quantity: 2, subtotal: 100, promotionIds: ['promo1'], discountCodes: ['KODE1'], id: 'r2', lineNo: 2 },
      { productId: 'p5', productName: 'R', variantSize: '5ml', price: 0, quantity: 1, subtotal: 0, isReward: true, rewardPromotionId: 'promo2' },
    ],
  } as unknown as Order

  it('keeps customer, codes and bundle groups', () => {
    const h = heldOrderFromVoidedOrder(order, 1000)
    expect(h.v).toBe(1)
    expect(h.heldAt).toBe(1000)
    expect(h.customer).toMatchObject({ id: 'cu1', name: 'Sari' })
    expect(h.salesman).toEqual({ id: 'sm1', name: 'Budi' })
    expect(h.notes).toBe('cat')
    expect([...h.codes].sort()).toEqual(['HEMAT', 'KODE1'])
    expect(h.promotions.map((p) => p.id)).toEqual(['promo1'])
    expect(h.discount).toEqual({ value: 10, type: 'percentage' })
    expect(h.surcharge).toEqual({ value: 5000, type: 'fixed' })
    const pieces = h.lines.filter((l) => l.bundleGroup === 1)
    expect(pieces.map((l) => l.bundleRole)).toEqual(['large', 'atomizer', 'vial'])
    expect(pieces[0]).toMatchObject({ bundleLine: 'EXTRAIT DE PARFUM', bundleSize: '120ml', bundlePrice: 300, isBundle: true })
    // Server-only row fields and reward lines are not carried into a draft.
    expect(h.lines.some((l) => 'id' in l || 'lineNo' in l || 'netAmount' in l || l.isReward)).toBe(false)
    expect(h.lines.find((l) => l.productId === 'p4')).not.toHaveProperty('promotionIds')
    expect(h.rewardPicks.promo2).toEqual([{ productId: 'p5', productName: 'R', variantSize: '5ml', net: 0 }])
  })
  it('flags redeemed points and loyalty reward lines for re-picking', () => {
    expect(heldOrderFromVoidedOrder({ ...order, pointsRedeemed: 50 } as Order, 1).loyaltyDropped).toBe(true)
    expect(heldOrderFromVoidedOrder(order, 1).loyaltyDropped).toBe(false)
  })
  it('is accepted by the held-restore planner', () => {
    const h = heldOrderFromVoidedOrder(order, 1)
    const plan = planHeldRestore(h, { products: [], promotions: [], discountCodes: [], ctx: { now: new Date(), outletId: 'o1', timezone: 'Asia/Jakarta' } } as never)
    expect(plan.actions[0]).toEqual({ type: 'CART_CLEAR' })
  })
})
