import { afterEach, expect, it, vi } from 'vitest'
import type { components } from '@mandalika/api'
import { SyncEngine, type KV, type OutboxItem } from '@mandalika/sync'
import { buildPromotionMetadata } from './promotionMetadata'
import { computePricing, type PricingInput } from './pricing'
import { decideApplyCode, type AppliedPromoCode } from './promoValidate'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'

type Promotion = components['schemas']['Promotion']
type Code = components['schemas']['DiscountCode']
const promo = (id = 'P', combinable = true): Promotion => ({ id, name: 'Ten percent', type: 'tiered', value: 0, isActive: true, createdAt: '', combinable, tieredConfig: { tiers: [{ minSubtotal: 0, kind: 'percentage', value: 10 }] } })
const rawCode = (p: Promotion, code = 'Raw-Code-1'): Code => ({ id: code, code, promotionId: p.id, type: 'fixed', value: 999, usageCount: 0, isActive: true, customerId: 'Raw-Customer', createdAt: '' })
function select(p: Promotion, raw = rawCode(p)): AppliedPromoCode {
  const d = decideApplyCode(raw.code.toLowerCase(), [raw], { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 100000, hasCustomer: true, customerId: 'Raw-Customer' }, [p])
  if (!d.ok) throw new Error(d.reason)
  return d.code
}
const initial = (): CashierState => ({ ...CASHIER_INITIAL_STATE, cart: [{ productId: 'bottle', productName: 'Bottle', variantSize: '120ml', quantity: 1, price: 100000, subtotal: 100000 }] })
const direct = (s: CashierState, p: Promotion) => cashierReducer(s, { type: 'APPLY_PROMOTION', promotion: p })
const linked = (s: CashierState, p: Promotion, code = 'Raw-Code-1') => {
  const c = select(p, rawCode(p, code))
  return cashierReducer(s, { type: 'APPLY_PROMO_CODE', code: c, combinable: !!c.combinable })
}
const quote = (s: CashierState) => computePricing({ cart: s.cart, appliedPromotions: s.appliedPromotions, appliedPromoCodes: s.appliedPromoCodes,
  discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
  settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as PricingInput['settings'],
  loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as PricingInput['loyalty'], hasCustomer: true, pointsRedeemed: 0, customerPoints: 0 })

afterEach(() => { vi.unstubAllGlobals() })

it.each([true, false])('LP05 regression direct then linked, combinable=%s', combinable => {
  const p = promo('P', combinable), state = linked(direct(initial(), p), p)
  expect(quote(state).total).toBe(90000)
  expect(state.appliedPromotions.map(p => p.id)).toEqual(['P'])
  expect(state.appliedPromoCodes).toEqual([])
})
it.each([true, false])('LP05 regression linked then direct, combinable=%s', combinable => {
  const p = promo('P', combinable), state = direct(linked(initial(), p), p)
  expect(quote(state).total).toBe(90000)
  expect(state.appliedPromotions.map(p => p.id)).toEqual(['P'])
  expect(state.appliedPromoCodes).toEqual([])
})
it.each([true, false])('LP05 regression first linked identity wins, combinable=%s', combinable => {
  const p = promo('P', combinable), state = linked(linked(initial(), p), p, 'Raw-Code-2')
  expect(quote(state).total).toBe(90000)
  expect(state.appliedPromoCodes.map(c => c.code)).toEqual(['Raw-Code-1'])
})
it('LP05 regression discard same-ID code before checking direct combinability', () => {
  // A prior selected snapshot can differ from incoming current promo metadata.
  const p = promo(), staleCode = { ...select(p), combinable: false }
  const state = direct({ ...initial(), appliedPromotions: [promo('Unrelated')], appliedPromoCodes: [staleCode] }, p)
  expect(state.appliedPromotions.map(p => p.id)).toEqual(['Unrelated', 'P'])
  expect(state.appliedPromoCodes).toEqual([])
  expect(quote(state).total).toBe(80000)
})

it('same raw code is a no-op, different IDs and unlinked codes remain independent', () => {
  const p = promo(), first = linked(initial(), p)
  expect(linked(first, p).appliedPromoCodes).toEqual(first.appliedPromoCodes)
  const different = linked(direct(initial(), p), promo('Other'))
  expect(quote(different).total).toBe(80000)
  const flat: AppliedPromoCode = { code: 'Unlinked-Raw', type: 'percentage', value: 10, combinable: true }
  const state = cashierReducer(direct(initial(), p), { type: 'APPLY_PROMO_CODE', code: flat, combinable: true })
  expect(quote(state).total).toBe(80000)
  expect(state.appliedPromoCodes.map(c => c.code)).toEqual(['Unlinked-Raw'])
})

it('code-only promotion remains usable through its linked code', () => {
  const state = linked(initial(), { ...promo(), codeOnly: true })
  expect(state.appliedPromotions).toEqual([])
  expect(quote(state).total).toBe(90000)
})

it('discarded linked selections do not resurrect after remove, toggle or clear', () => {
  const p = promo(), replaced = direct(linked(initial(), p), p)
  for (const action of [{ type: 'REMOVE_PROMOTION' as const, id: 'P' }, { type: 'APPLY_PROMOTION' as const, promotion: p }, { type: 'CLEAR_PROMOTIONS' as const }]) {
    const removed = cashierReducer(replaced, action)
    expect(removed.appliedPromotions).toEqual([])
    expect(removed.appliedPromoCodes).toEqual([])
    expect(quote(removed).total).toBe(100000)
  }
  const two = linked(linked(initial(), p), p, 'Raw-Code-2')
  const removed = cashierReducer(two, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Code-1' })
  expect(removed.appliedPromoCodes).toEqual([])
  expect(quote(removed).total).toBe(100000)
})

it('redundant exclusive code preserves unrelated selections; incoming exclusive direct still replaces them', () => {
  const p = promo(), base = direct(direct(initial(), promo('Other')), p)
  const redundant = cashierReducer(base, { type: 'APPLY_PROMO_CODE', code: { ...select(p), combinable: false }, combinable: false })
  expect(redundant.appliedPromotions).toEqual(base.appliedPromotions)
  expect(redundant.appliedPromoCodes).toEqual([])
  const exclusive = direct(linked(direct(initial(), promo('Other')), p), promo('P', false))
  expect(exclusive.appliedPromotions.map(p => p.id)).toEqual(['P'])
  expect(exclusive.appliedPromoCodes).toEqual([])
  expect(quote(exclusive).total).toBe(90000)
})

it.each(['direct-first', 'linked-first'] as const)('bundle ownership and stock survive redundant linked metadata (%s)', order => {
  const p: Promotion = { ...promo(), type: 'bundle' }
  const freed = [{ productId: 'bottle', productName: 'Bottle', variantSize: '120ml', fullPrice: 100000, net: 90000, quantity: 1 }]
  const applied = cashierReducer(order === 'linked-first' ? linked(initial(), p) : initial(), { type: 'APPLY_BUNDLE', promotion: p, freed, applications: 1 })
  const selected = linked(applied, p)
  const kept = cashierReducer(selected, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Code-1' })
  expect(kept.appliedPromotions.map(p => p.id)).toEqual(['P'])
  expect(kept.appliedPromoCodes).toEqual([])
  expect(kept.cart).toEqual(applied.cart)
  expect(kept.cart).toEqual([expect.objectContaining({ productId: 'bottle', quantity: 1, price: 90000, isReward: true, rewardPromotionId: 'P' })])
  expect(kept.bundleFreed).toEqual({ P: freed })
  expect(kept.bundleApplications).toEqual({ P: 1 })
  for (const cleared of [cashierReducer(kept, { type: 'CLEAR_PROMOTIONS' }), direct(kept, promo('Exclusive', false))]) {
    expect(cleared.cart).toEqual(initial().cart)
    expect(cleared.bundleFreed).toEqual({})
    expect(cleared.bundleApplications).toEqual({})
    expect(cleared.appliedPromoCodes).toEqual([])
  }
})

it('redundant code removal preserves direct BXGY and loyalty rewards; clear/exclusive retain ordinary ownership behavior', () => {
  const p: Promotion = { ...promo(), type: 'buy_x_get_y', bxgyConfig: {
    buyQuantity: 1, getQuantity: 1, buyProductIds: ['bottle'], getProductIds: ['reward'], getDiscountKind: 'percentage', getDiscountValue: 100,
  } }
  let state = direct(initial(), p)
  const reward = { productId: 'reward', productName: 'Reward', variantSize: '2ml', quantity: 1, price: 0, subtotal: 0, isReward: true as const }
  state = cashierReducer(state, { type: 'CART_ADD_REWARD', item: { ...reward, rewardPromotionId: 'P' } })
  state = cashierReducer(state, { type: 'CART_ADD_REWARD', item: { ...reward, productId: 'loyalty', rewardConditionId: 'L' } })
  const kept = cashierReducer(linked(state, p), { type: 'REMOVE_PROMO_CODE', code: 'Raw-Code-1' })
  expect(kept.cart).toEqual(state.cart)
  for (const cleared of [cashierReducer(kept, { type: 'CLEAR_PROMOTIONS' }), direct(kept, promo('Exclusive', false))]) {
    expect(cleared.cart.filter(c => c.rewardPromotionId)).toEqual([])
    expect(cleared.cart.filter(c => c.rewardConditionId)).toEqual(state.cart.filter(c => c.rewardConditionId))
    expect(cleared.cart.filter(c => !c.isReward)).toEqual(initial().cart)
  }
})

it('pricing and capture project stale duplicate draft identities without mutating the input', () => {
  const p = promo(), code = select(p)
  const state = { ...initial(), appliedPromotions: [p, p], appliedPromoCodes: [code, select(p, rawCode(p, 'Raw-Code-2'))] }
  const before = structuredClone(state)
  Object.freeze(state.appliedPromotions)
  Object.freeze(state.appliedPromoCodes)
  Object.freeze(state)
  expect(quote(state).total).toBe(90000)
  expect(buildPromotionMetadata(state, quote(state))).toEqual({ promotionIds: ['P'], promotionId: 'P', discountCodes: [], discountCode: null,
    discountLabel: 'Ten percent', discountBreakdown: [{ label: 'Ten percent', kind: 'tiered', value: 0, amount: 10000 }] })
  expect(state).toEqual(before)
  const removed = cashierReducer(state, { type: 'REMOVE_PROMOTION', id: 'P' })
  expect(removed.appliedPromotions).toEqual([])
  expect(removed.appliedPromoCodes).toEqual([])
})

function memoryKV(): KV {
  const values = new Map<string, string>()
  return { get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value) }, remove: key => { values.delete(key) },
    setDurable: async (key, value) => { values.set(key, value) }, removeDurable: async key => { values.delete(key) } }
}

it.each(['direct-first', 'linked-first', 'two-linked', 'code-only', 'different-ids', 'unlinked'] as const)(
  'real enqueue/reconstruction captures one identity effect and usage intent: %s', async order => {
    vi.stubGlobal('navigator', { onLine: false })
    const kv = memoryKV(), request = vi.fn(async () => { throw new Error('No network permitted in this fixture') })
    const engine = new SyncEngine({ request }, {}, kv, { actor: null }), p = promo()
    const states = {
      'direct-first': linked(direct(initial(), p), p),
      'linked-first': direct(linked(initial(), p), p),
      'two-linked': linked(linked(initial(), p), p, 'Raw-Code-2'),
      'code-only': linked(initial(), { ...p, codeOnly: true }),
      'different-ids': linked(direct(initial(), p), promo('Other')),
      unlinked: cashierReducer(direct(initial(), p), { type: 'APPLY_PROMO_CODE', code: { code: 'Unlinked-Raw', type: 'percentage', value: 10, combinable: true }, combinable: true }),
    }
    const state = states[order], derived = quote(state), metadata = buildPromotionMetadata(state, derived)
    const receipt = await engine.enqueue('order', { outletId: 'fixture-outlet', customerId: 'Raw-Customer', items: state.cart,
      paymentMethod: 'cash', amountPaid: derived.total, ...metadata }, `lp05-${order}`)
    const queued = new SyncEngine({ request }, {}, kv, { actor: null }).outbox.pending()[0]
    const codeWinner = order === 'two-linked' || order === 'code-only'
    const independent = order === 'different-ids' || order === 'unlinked'
    expect(queued.idempotencyKey).toBe(receipt.idempotencyKey)
    expect(derived.total).toBe(independent ? 80000 : 90000)
    expect(queued.payload).toMatchObject({ orderUuid: `lp05-${order}`, customerId: 'Raw-Customer', amountPaid: independent ? 80000 : 90000,
      promotionIds: codeWinner ? [] : ['P'], promotionId: codeWinner ? null : 'P',
      discountCodes: codeWinner || order === 'different-ids' ? ['Raw-Code-1'] : order === 'unlinked' ? ['Unlinked-Raw'] : [],
      discountCode: codeWinner || order === 'different-ids' ? 'Raw-Code-1' : order === 'unlinked' ? 'Unlinked-Raw' : null,
      discountLabel: codeWinner ? 'Raw-Code-1' : 'Ten percent' })
    expect(queued.payload.discountBreakdown).toHaveLength(independent ? 2 : 1)
    expect(metadata.discountBreakdown?.reduce((sum, row) => sum + row.amount, 0)).toBe(independent ? 20000 : 10000)
    expect(request).not.toHaveBeenCalled()
  },
)

it('capture keeps manual discount evidence independent of promotion identity', () => {
  const state = { ...linked(direct(initial(), promo()), promo()), discountRunning: 5000 }
  const metadata = buildPromotionMetadata(state, { subtotal: 100000, manualDiscountAmount: 5000 })
  expect(metadata.discountBreakdown).toEqual([
    { label: 'Diskon Manual', kind: 'fixed', value: 5000, amount: 5000 },
    { label: 'Ten percent', kind: 'tiered', value: 0, amount: 10000 },
  ])
})

it('new capture and reconstruction leave a historical duplicate queued sale and error evidence intact', async () => {
  vi.stubGlobal('navigator', { onLine: false })
  const kv = memoryKV(), request = vi.fn(async () => { throw new Error('No network permitted in this fixture') })
  const historical: OutboxItem = { idempotencyKey: 'original-device:original-sale', type: 'order', seq: 17, status: 'failed', attempts: 5,
    clientCreatedAt: '2026-09-01T05:00:00Z', lastError: 'Original reconciliation evidence', payload: { promotionIds: ['P'], discountCodes: ['Raw-Code-1', 'Raw-Code-2'],
      promotionId: 'P', discountCode: 'Raw-Code-1', total: 70000, amountPaid: 70000, orderUuid: 'original-sale', clientCreatedAt: '2026-09-01T05:00:00Z' } }
  const originalBytes = JSON.stringify(historical)
  kv.set('mandalika.pos.outbox', JSON.stringify([historical]))
  const engine = new SyncEngine({ request }, {}, kv, { actor: null }), state = linked(direct(initial(), promo()), promo())
  await engine.enqueue('order', { ...buildPromotionMetadata(state, quote(state)), amountPaid: quote(state).total }, 'new-sale')
  const reconstructed = new SyncEngine({ request }, {}, kv, { actor: null })
  expect(reconstructed.outbox.deadLettered()).toEqual([historical])
  expect(JSON.stringify(reconstructed.outbox.deadLettered()[0])).toBe(originalBytes)
  expect(reconstructed.outbox.pending()).toHaveLength(1)
  expect(reconstructed.outbox.pending()[0].seq).toBe(18)
  expect(reconstructed.outbox.pending()[0].payload.discountCodes).toEqual([])
  expect(request).not.toHaveBeenCalled()
})
