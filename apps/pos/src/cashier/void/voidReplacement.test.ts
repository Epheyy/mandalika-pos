import { describe, expect, it } from 'vitest'
import type { components } from '@mandalika/api'
import { planHeldRestore } from '../heldRestore'
import {
  heldOrderFromVoidedOrder, initialReplacementTenders, lockedReplacementTenders, lockedTendersProblem, replacementCorrection, type VoidDraft,
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
  it('rounds the cart total and is built from the amount due', () => {
    expect(replacementCorrection(draft(), 89999.6, 'adjust')).toEqual({ correctionTarget: 'original_total', correction: 10000 })
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

describe('lockedTendersProblem', () => {
  it('is null when the applied lines add up and carries the server text otherwise', () => {
    expect(lockedTendersProblem([{ method: 'qris', amount: 60000 }, { method: 'cash', amount: 40000 }], 100000)).toBeNull()
    expect(lockedTendersProblem([{ method: 'cash', amount: 150000 }], 1250000))
      .toBe('Jumlah pembayaran pengganti harus sama dengan yang diterima (Rp 1.250.000).')
  })
})

describe('heldOrderFromVoidedOrder', () => {
  type Item = Order['items'][number]
  const bundle = (role: 'large' | 'atomizer' | 'vial', productId: string): Item => ({
    id: `row-${role}`, productId, productName: role, variantSize: role === 'large' ? '120ml' : '2ml', price: 100, quantity: 1, subtotal: 100,
    isBundle: true, lineNo: 1, netAmount: 100, refundGroup: null, refundedQty: 0,
    bundleGroup: 1, bundleRole: role, bundleLine: 'EXTRAIT DE PARFUM', bundleSize: '120ml', bundleDiscount: 0, bundlePromotionId: 'bp1',
  })
  const plain = (over: Partial<Item>): Item => ({
    id: 'r', productId: 'p4', productName: 'D', variantSize: '30ml', price: 50, quantity: 2, subtotal: 100,
    isBundle: false, lineNo: 2, netAmount: 100, refundGroup: null, refundedQty: 0, ...over,
  })
  const order: Order = {
    id: 'ord1', orderNumber: 'BSD-1', outletId: 'o1', cashierId: 'c1', cashierName: 'C', customerId: 'cu1', customerName: 'Sari',
    salesmanId: 'sm1', salesmanName: 'Budi', notes: 'cat', subtotal: 1, discountAmount: 0, taxAmount: 0, total: 1,
    paymentMethod: 'cash', amountPaid: 1, change: 0, status: 'completed', createdAt: '2026-11-14T09:00:00Z',
    discountType: 'percentage', discountValue: 10, surchargeType: 'fixed', surchargeValue: 5000, discountCode: 'HEMAT',
    pointsRedeemed: 0,
    items: [
      bundle('large', 'p1'), bundle('atomizer', 'p2'), bundle('vial', 'p3'),
      plain({ refundGroup: 'bxgy:promo1:1' }),
      plain({ id: 'g', productId: 'p5', productName: 'R', variantSize: '5ml', price: 0, quantity: 2, subtotal: 0, netAmount: 0, refundGroup: 'bxgy:promo1:1' }),
    ],
  }

  it('keeps customer, code, promotion, gift and bundle groups from real read fields', () => {
    const h = heldOrderFromVoidedOrder(order, 1000)
    expect(h.v).toBe(1)
    expect(h.heldAt).toBe(1000)
    expect(h.customer).toMatchObject({ id: 'cu1', name: 'Sari' })
    expect(h.salesman).toEqual({ id: 'sm1', name: 'Budi' })
    expect(h.notes).toBe('cat')
    expect(h.codes).toEqual(['HEMAT'])
    expect(h.promotions.map((p) => p.id)).toEqual(['promo1'])
    expect(h.discount).toEqual({ value: 10, type: 'percentage' })
    expect(h.surcharge).toEqual({ value: 5000, type: 'fixed' })
    const pieces = h.lines.filter((l) => l.bundleGroup === 1)
    expect(pieces.map((l) => l.bundleRole)).toEqual(['large', 'atomizer', 'vial'])
    expect(pieces[0]).toMatchObject({ bundleLine: 'EXTRAIT DE PARFUM', bundleSize: '120ml', isBundle: true })
    // Server row fields are dropped, and so is the Rp0 gift line (it comes back through rewardPicks).
    expect(h.lines.some((l) => 'id' in l || 'lineNo' in l || 'netAmount' in l || 'refundGroup' in l)).toBe(false)
    expect(h.lines.map((l) => l.productId)).not.toContain('p5')
    expect(h.rewardPicks.promo1).toEqual([
      { productId: 'p5', productName: 'R', variantSize: '5ml', net: 0 },
      { productId: 'p5', productName: 'R', variantSize: '5ml', net: 0 },
    ])
    expect(h.loyaltyDropped).toBe(false)
    expect(h.restoreNotes).toEqual([
      'Pilih ulang pelanggan agar poin dan segmen terbaru terpasang',
      'Kode Promo lain (jika ada) harus dipasang ulang di Promo & Diskon',
    ])
  })
  it('drops a Rp0 line without a group as a loyalty reward', () => {
    const h = heldOrderFromVoidedOrder({ ...order, items: [plain({}), plain({ id: 'x', productId: 'p9', price: 0, subtotal: 0, netAmount: 0 })] }, 1)
    expect(h.lines.map((l) => l.productId)).toEqual(['p4'])
    expect(h.loyaltyDropped).toBe(true)
  })
  it('flags redeemed points and loyalty reward lines for re-picking', () => {
    expect(heldOrderFromVoidedOrder({ ...order, pointsRedeemed: 50 }, 1).loyaltyDropped).toBe(true)
    expect(heldOrderFromVoidedOrder(order, 1).loyaltyDropped).toBe(false)
  })
  it('is accepted by the held-restore planner', () => {
    const h = heldOrderFromVoidedOrder(order, 1)
    const plan = planHeldRestore(h, { products: [], promotions: [], discountCodes: [], ctx: { now: new Date(), outletId: 'o1', timezone: 'Asia/Jakarta' } } as never)
    expect(plan.actions[0]).toEqual({ type: 'CART_CLEAR' })
    expect(plan.notes).toContain('Pilih ulang pelanggan agar poin dan segmen terbaru terpasang')
  })
})
