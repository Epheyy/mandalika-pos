import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { SyncEngine, type KV, type ApiLike, type OutboxItem } from '@mandalika/sync'
import type { components } from '@mandalika/api'
import { cashierReducer, CASHIER_INITIAL_STATE, type CashierState } from './state/cashierReducer'
import { decideApplyCode, type AppliedPromoCode } from './promoValidate'
import { computeBundleFreed } from './bundle'
import { linkedPromoShape, computePricing, type PricingInput } from './pricing'
import { planPromotionFulfillment, invalidPhysicalPromotionIds, promotionPreviewCart, type PromotionOwner, type FulfillmentChoice } from './promotionFulfillment'
import { buildPromotionMetadata } from './promotionMetadata'

type Promotion = components['schemas']['Promotion']
type CartItem = components['schemas']['CartItem']
type Product = components['schemas']['Product']
const line = (id: string, price: number, quantity = 1): CartItem => ({ productId: id, productName: id, variantSize: 'M', price, quantity, subtotal: price * quantity })
const product = (id: string, price: number): Product => ({ id, name: id, brand: 'Fixture', categoryId: '', isFeatured: false, isFavourite: false,
  isActive: true, createdAt: '', variants: [{ size: 'M', price, stock: 100, sku: `fixture-${id}` }] })
const products = [product('buy', 100000), product('reward', 20000)]
const promo = (type: 'bundle' | 'buy_x_get_y', id = 'P'): Promotion => ({
  id, name: type, type, value: 0, isActive: true, codeOnly: true, createdAt: '', combinable: true,
  bundleConfig: type === 'bundle' ? { slots: [{ productKeys: ['buy'], quantity: 1 }, { productKeys: ['reward'], quantity: 1 }], bundlePrice: 105000 } : null,
  bxgyConfig: type === 'buy_x_get_y' ? { buyQuantity: 1, getQuantity: 1, buyProductIds: ['buy'], getProductIds: ['reward'], getDiscountKind: 'percentage', getDiscountValue: 50 } : null,
})
function code(p: Promotion, raw = 'Raw-Winner'): AppliedPromoCode {
  const d = decideApplyCode(raw.toLowerCase(), [{ id: raw, code: raw, promotionId: p.id, type: 'fixed', value: 0, usageCount: 0, isActive: true, createdAt: '' }],
    { now: new Date('2026-09-20T05:00:00Z'), outletId: 'outlet', subtotal: 120000, hasCustomer: true }, [p])
  if (!d.ok) throw new Error(d.reason)
  return d.code
}
const initial = (p: Promotion): CashierState => ({ ...CASHIER_INITIAL_STATE, cart: p.type === 'bundle' ? [line('buy', 100000), line('reward', 20000)] : [line('buy', 100000)] })
function chooseCode(state: CashierState, p: Promotion): CashierState {
  const selected = code(p)
  // Same real planner and commit action used by the refactored screen handler.
  const owner = { kind: 'code' as const, code: selected }
  const plan = planPromotionFulfillment(state, owner, products)
  return plan.kind === 'ready' ? cashierReducer(state, { type: 'APPLY_FULFILLMENT', owner, products }) : state
}
const owned = (state: CashierState, id: string) => state.cart.filter(c => c.productId === id).reduce((n, c) => n + c.quantity, 0)
function seededPhysical(p: Promotion): CashierState {
  if (p.type === 'bundle') {
    const start = initial(p), freed = computeBundleFreed(p.bundleConfig, start.cart)!
    const direct = cashierReducer(start, { type: 'APPLY_BUNDLE', promotion: p, freed, applications: 1 })
    return { ...direct, appliedPromotions: [], appliedPromoCodes: [code(p)] }
  }
  return { ...initial(p), cart: [line('buy', 100000), { ...line('reward', 10000), isReward: true, rewardPromotionId: p.id }], appliedPromoCodes: [code(p)] }
}

it('LF regression: linked bundle snapshot carries the allocator configuration', () => {
  const p = promo('bundle')
  expect(linkedPromoShape(code(p)).bundleConfig).toEqual(p.bundleConfig)
})
it.each(['bundle', 'buy_x_get_y'] as const)('LF regression: code-only %s actually fulfills its physical effect', type => {
  const p = promo(type), selected = chooseCode(initial(p), p)
  expect(selected.appliedPromotions).toEqual([])
  expect(selected.appliedPromoCodes.map(c => c.code)).toEqual(['Raw-Winner'])
  expect(selected.cart.filter(c => c.rewardPromotionId === 'P')).toEqual([expect.objectContaining({ productId: 'reward', quantity: 1, price: type === 'bundle' ? 5000 : 10000 })])
  expect(owned(selected, 'buy')).toBe(1)
  expect(owned(selected, 'reward')).toBe(1)
})
it.each(['bundle', 'buy_x_get_y'] as const)('LF regression: remove linked %s effect exactly once', type => {
  const p = promo(type), state = seededPhysical(p)
  const removed = cashierReducer(state, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Winner' })
  expect(removed.cart).toEqual(initial(p).cart)
  expect(removed.bundleFreed).toEqual({})
  expect(removed.bundleApplications).toEqual({})
  expect(removed.appliedPromoCodes).toEqual([])
  expect(cashierReducer(removed, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Winner' }).cart).toEqual(initial(p).cart)
})
it('LF regression: participant edit removes the linked bundle owner as well as its effect', () => {
  const state = cashierReducer(seededPhysical(promo('bundle')), { type: 'CART_SET_QTY', productId: 'reward', variantSize: 'M', quantity: 2 })
  expect(state.appliedPromoCodes).toEqual([])
  expect(state.bundleFreed).toEqual({})
  expect(owned(state, 'buy')).toBe(1)
  expect(owned(state, 'reward')).toBe(2)
})

afterEach(() => vi.unstubAllGlobals())
const directOwner = (p: Promotion): PromotionOwner => ({ kind: 'direct', promotion: { ...p, codeOnly: false } })
const codeOwner = (p: Promotion, raw?: string): PromotionOwner => ({ kind: 'code', code: code(p, raw) })
const commit = (s: CashierState, owner: PromotionOwner, catalog = products, choice?: FulfillmentChoice) =>
  cashierReducer(s, { type: 'APPLY_FULFILLMENT', owner, products: catalog, choice })
const reconcile = (s: CashierState) => invalidPhysicalPromotionIds(s).reduce((next, id) => cashierReducer(next, { type: 'REMOVE_PROMOTION', id }), s)
const price = (s: CashierState) => computePricing({ cart: s.cart, appliedPromotions: s.appliedPromotions, appliedPromoCodes: s.appliedPromoCodes,
  discountType: 'fixed', surchargeType: 'fixed', discountRunning: 0, surchargeRunning: 0,
  settings: { taxEnabled: false, taxRate: 0, roundingEnabled: false, roundingType: 'none' } as PricingInput['settings'],
  loyalty: { enabled: false, pointsPerThousand: 0, redemptionRate: 0 } as PricingInput['loyalty'], hasCustomer: true, pointsRedeemed: 0, customerPoints: 0 })

it.each(['bundle', 'buy_x_get_y'] as const)('direct and linked %s share physical allocation, only selection provenance differs', type => {
  const p = promo(type), start = initial(p), direct = commit(start, directOwner(p)), linked = commit(start, codeOwner(p))
  expect(linked.cart).toEqual(direct.cart)
  expect(price(linked)).toEqual(price(direct))
  expect(linked.bundleFreed).toEqual(direct.bundleFreed)
  expect(linked.bundleApplications).toEqual(direct.bundleApplications)
  expect(linked.appliedPromotions).toEqual([])
  expect(direct.appliedPromoCodes).toEqual([])
  expect(invalidPhysicalPromotionIds(linked)).toEqual([])
  const metadata = buildPromotionMetadata(linked, price(linked))
  expect(metadata).toMatchObject({ promotionIds: [], promotionId: null, discountCodes: ['Raw-Winner'], discountCode: 'Raw-Winner', discountLabel: 'Raw-Winner' })
  // Physical savings are already in item prices, never applied a second time.
  expect(metadata.discountBreakdown).toEqual([{ label: 'Raw-Winner', kind: type, value: 0, amount: 0 }])
})

it('BXGY picker preview/cancel is a pure no-op; confirm aggregates exactly the earned picks', () => {
  const p = promo('buy_x_get_y'), start = { ...initial(p), cart: [line('buy', 100000, 2)] }
  const catalog = [...products, product('reward2', 30000)]
  p.bxgyConfig!.getProductIds = ['reward', 'reward2']
  const owner = codeOwner(p), before = structuredClone(start)
  const plan = planPromotionFulfillment(start, owner, catalog)
  expect(plan.kind).toBe('bxgy-picker')
  if (plan.kind !== 'bxgy-picker') throw new Error('Expected picker')
  expect(plan.due).toBe(2)
  expect(plan.options.map(o => o.net)).toEqual([10000, 15000])
  // Screen cancel only drops this pending plan, without dispatching a mutation.
  expect(start).toEqual(before)
  expect(buildPromotionMetadata(start, price(start)).discountCodes).toEqual([])
  expect(commit(start, owner, catalog)).toBe(start)
  expect(commit(start, owner, catalog, { kind: 'bxgy', picks: [plan.options[0]] })).toBe(start)
  const choice: FulfillmentChoice = { kind: 'bxgy', picks: [plan.options[1], plan.options[1]] }
  const next = commit(start, owner, catalog, choice)
  expect(next.cart.filter(c => c.isReward)).toEqual([expect.objectContaining({ productId: 'reward2', price: 15000, quantity: 2, subtotal: 30000, rewardPromotionId: 'P' })])
  expect(next.cart).toEqual(commit(start, directOwner(p), catalog, choice).cart)
  expect(commit(next, owner, catalog, choice)).toBe(next)
  expect(commit(start, owner, catalog, { kind: 'bxgy', picks: [{ ...plan.options[0], productId: 'forged' }, plan.options[0]] })).toBe(start)
  const reduced = cashierReducer(next, { type: 'CART_SET_QTY', productId: 'buy', variantSize: 'M', quantity: 1 })
  const cleared = reconcile(reduced)
  expect(cleared.cart).toEqual([line('buy', 100000)])
  expect(cleared.appliedPromoCodes).toEqual([])
})

function ambiguousBundle() {
  const p = promo('bundle')
  p.bundleConfig!.slots[1].productKeys = ['reward', 'dearer']
  const start = { ...initial(p), cart: [...initial(p).cart, line('dearer', 30000)] }
  return { p, start, choice: { kind: 'bundle' as const, assignment: { 1: [{ productId: 'dearer', variantSize: 'M' }] } } }
}

it('bundle picker cancel is a no-op; confirm preserves free choice, maps and physical quantity', () => {
  const { p, start, choice } = ambiguousBundle(), owner = codeOwner(p), before = structuredClone(start)
  const plan = planPromotionFulfillment(start, owner, products)
  expect(plan.kind).toBe('bundle-picker')
  expect(start).toEqual(before)
  expect(commit(start, owner)).toBe(start)
  expect(commit(start, owner, products, { kind: 'bundle', assignment: {} })).toBe(start)
  const next = commit(start, owner, products, choice)
  expect(next.cart).toEqual(commit(start, directOwner(p), products, choice).cart)
  for (const id of ['buy', 'reward', 'dearer']) expect(owned(next, id)).toBe(owned(start, id))
  expect(next.bundleFreed.P).toEqual([{ productId: 'dearer', productName: 'dearer', variantSize: 'M', fullPrice: 30000, net: 5000, quantity: 1 }])
  expect(next.bundleApplications).toEqual({ P: 1 })
  expect(invalidPhysicalPromotionIds(next)).toEqual([])
  const removed = cashierReducer(next, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Winner' })
  expect(removed.cart).toEqual(start.cart)
  expect(cashierReducer(removed, { type: 'REMOVE_BUNDLE', promotionId: 'P', freed: next.bundleFreed.P }).cart).toEqual(start.cart)
})

it.each(['bundle', 'buy_x_get_y'] as const)('%s direct takeover restores old code effect before recomputing; later linked input is inert', type => {
  const p = promo(type), linked = commit(initial(p), codeOwner(p))
  const direct = commit(linked, directOwner(p))
  expect(direct.cart).toEqual(commit(initial(p), directOwner(p)).cart)
  expect(direct.appliedPromoCodes).toEqual([])
  expect(direct.appliedPromotions.map(p => p.id)).toEqual(['P'])
  expect(planPromotionFulfillment(direct, codeOwner(p), products).kind).toBe('none')
  expect(commit(direct, codeOwner(p))).toBe(direct)
  const cleared = cashierReducer(direct, { type: 'REMOVE_PROMOTION', id: 'P' })
  expect(cleared.cart).toEqual(initial(p).cart)
  expect(cleared.appliedPromoCodes).toEqual([])
})

it('cancel direct takeover picker retains the old linked owner/effect until confirmation', () => {
  const { p, start, choice } = ambiguousBundle(), linked = commit(start, codeOwner(p), products, choice), before = structuredClone(linked)
  const preview = planPromotionFulfillment(linked, directOwner(p), products)
  expect(preview.kind).toBe('bundle-picker')
  if (preview.kind !== 'bundle-picker') throw new Error('Expected picker')
  expect(preview.cart).toEqual(start.cart)
  expect(promotionPreviewCart(linked, { ...p, codeOnly: false })).toEqual(start.cart)
  expect(linked).toEqual(before)
  const direct = commit(linked, directOwner(p), products, choice)
  expect(direct.cart).toEqual(linked.cart)
  expect(direct.appliedPromoCodes).toEqual([])
})

it('bundle reactive anchor shrink removes linked owner and restores moved units once', () => {
  const p = promo('bundle'), start = { ...initial(p), cart: [line('buy', 100000, 2), line('reward', 20000, 2)] }
  const applied = commit(start, codeOwner(p))
  expect(applied.bundleApplications).toEqual({ P: 2 })
  const edited = cashierReducer(applied, { type: 'CART_SET_QTY', productId: 'buy', variantSize: 'M', quantity: 1 })
  expect(invalidPhysicalPromotionIds(edited)).toEqual(['P'])
  const cleared = reconcile(edited)
  expect(cleared.cart).toEqual([line('buy', 100000), line('reward', 20000, 2)])
  expect(cleared.appliedPromoCodes).toEqual([])
  expect(cleared.bundleApplications).toEqual({})
  expect(reconcile(cleared)).toEqual(cleared)
})

it.each(['bundle', 'buy_x_get_y'] as const)('%s second linked code cannot rerun fulfillment and does not resurrect', type => {
  const p = promo(type), first = commit(initial(p), codeOwner(p))
  expect(planPromotionFulfillment(first, codeOwner(p, 'Second-Raw'), products).kind).toBe('none')
  expect(commit(first, codeOwner(p, 'Second-Raw'))).toBe(first)
  expect(cashierReducer(first, { type: 'REMOVE_PROMO_CODE', code: 'Raw-Winner' }).appliedPromoCodes).toEqual([])
})

it.each(['bundle', 'buy_x_get_y'] as const)('%s exclusive replacement and customer cleanup cannot leave ghost linked effects', type => {
  const p = promo(type), linked = commit(initial(p), codeOwner(p))
  const exclusive: Promotion = { ...p, id: 'Other', type: 'percentage', value: 10, combinable: false }
  for (const action of [
    { type: 'APPLY_PROMOTION' as const, promotion: exclusive },
    { type: 'APPLY_PROMO_CODE' as const, code: { code: 'Unlinked', type: 'fixed' as const, value: 1 }, combinable: false },
    { type: 'SET_CUSTOMER' as const, customer: null },
    { type: 'CART_REMOVE_PROMO_REWARDS' as const, rewardPromotionId: 'P' },
  ]) {
    const next = cashierReducer(linked, action)
    expect(next.cart).toEqual(initial(p).cart)
    expect(next.appliedPromoCodes.some(c => c.promotion?.id === 'P')).toBe(false)
    expect(next.bundleFreed).toEqual({})
  }
})

it('clear restores direct and linked bundles together and keeps unrelated loyalty rewards', () => {
  const p = promo('bundle'), q: Promotion = { ...promo('bundle', 'Q'), bundleConfig: { slots: [{ productKeys: ['second'], quantity: 1 }], bundlePrice: 1000 } }
  const loyalty: CartItem = { ...line('loyalty', 0), isReward: true, rewardConditionId: 'L' }
  const start = { ...initial(p), cart: [...initial(p).cart, line('second', 30000), loyalty] }
  const both = commit(commit(start, codeOwner(p)), directOwner(q))
  expect(Object.keys(both.bundleFreed).sort()).toEqual(['P', 'Q'])
  const cleared = cashierReducer(both, { type: 'CLEAR_PROMOTIONS' })
  expect(cleared.cart.filter(c => !c.isReward).sort((a,b) => a.productId.localeCompare(b.productId))).toEqual(start.cart.filter(c => !c.isReward).sort((a,b) => a.productId.localeCompare(b.productId)))
  expect(cleared.cart.filter(c => c.isReward)).toEqual([loyalty])
  expect(cleared.appliedPromoCodes).toEqual([])
  expect(cleared.bundleFreed).toEqual({})
})

it('no entitlement or stale picker confirmation installs neither owner nor physical effect', () => {
  for (const type of ['bundle', 'buy_x_get_y'] as const) {
    const p = promo(type), empty = { ...initial(p), cart: [] }
    expect(planPromotionFulfillment(empty, codeOwner(p), products).kind).toBe('none')
    expect(commit(empty, codeOwner(p))).toBe(empty)
  }
  const p = promo('buy_x_get_y'), start = { ...initial(p), cart: [line('buy', 100000, 2)] }, owner = codeOwner(p)
  const plan = planPromotionFulfillment(start, owner, products)
  if (plan.kind !== 'bxgy-picker') throw new Error('Expected picker')
  const changed = { ...start, cart: [line('buy', 100000)] }
  expect(commit(changed, owner, products, { kind: 'bxgy', picks: [plan.options[0], plan.options[0]] })).toBe(changed)
})

it('selected linked mechanics are used from the snapshot, not a later catalog promotion', () => {
  const p = promo('bundle'), owner = codeOwner(p)
  const newer = { ...p, bundleConfig: { ...p.bundleConfig!, bundlePrice: 1 } }
  expect(commit(initial(p), owner).cart).toEqual(commit(initial(p), directOwner(p)).cart)
  expect(price(commit(initial(p), owner)).total).not.toBe(price(commit(initial(p), directOwner(newer))).total)
})

it('overlapping bundle slots cannot commit more freed units than the paid cart owns', () => {
  const p: Promotion = { ...promo('bundle'), bundleConfig: { slots: [{ productKeys: ['buy'], quantity: 1 }, { productKeys: ['buy'], quantity: 1 }], bundlePrice: 0 } }
  const start = { ...initial(p), cart: [line('buy', 100000)] }
  for (const owner of [codeOwner(p), directOwner(p)]) expect(commit(start, owner)).toBe(start)
})

it('stale ambiguous bundle picks are rejected even when the reduced cart is now unambiguous', () => {
  const { p, choice } = ambiguousBundle()
  const changed = { ...initial(p), cart: [line('buy', 100000), line('reward', 20000)] }
  // The old choice refers to dearer, which is no longer present. Do not silently
  // substitute reward merely because the new cart no longer needs a picker.
  expect(commit(changed, codeOwner(p), products, choice)).toBe(changed)
})

const memoryKV = (): KV => { const m = new Map<string,string>(); return { get: k => m.get(k) ?? null, set: (k,v) => { m.set(k,v) }, remove: k => { m.delete(k) } } }
it.each(['bundle', 'buy_x_get_y'] as const)('%s queue/reconstruction/response-loss retry preserves code-only provenance, quantities and original key', async type => {
  vi.stubGlobal('navigator', { onLine: false })
  const kv = memoryKV(), sent: unknown[] = [], p = promo(type), state = commit(initial(p), codeOwner(p))
  const api: ApiLike = { async request<T>(_method: string, path: string, body?: unknown): Promise<T> {
    expect(path).toBe('/api/v1/sync/batch'); sent.push(structuredClone(body))
    if (sent.length === 1) throw new Error('Synthetic lost response')
    const key = (body as { items: OutboxItem[] }).items[0].idempotencyKey
    return { data: { processed: 1, results: [{ idempotencyKey: key, status: 'ok' }], version: 0 } } as T
  } }
  const engine = new SyncEngine(api, {}, kv), derived = price(state)
  const receipt = engine.enqueue('order', { items: state.cart, amountPaid: derived.total, paymentMethod: 'cash', ...buildPromotionMetadata(state, derived) }, `original-${type}`)
  const captured = structuredClone(engine.outbox.all()[0])
  expect(captured.payload).toMatchObject({ promotionIds: [], promotionId: null, discountCodes: ['Raw-Winner'], discountCode: 'Raw-Winner', discountLabel: 'Raw-Winner' })
  expect(captured.payload.items).toEqual(state.cart)
  vi.stubGlobal('navigator', { onLine: true })
  await engine.flush()
  const rebuilt = new SyncEngine(api, {}, kv)
  expect(rebuilt.outbox.all()[0].payload).toEqual(captured.payload)
  expect(rebuilt.outbox.all()[0].idempotencyKey).toBe(receipt.idempotencyKey)
  await rebuilt.flush()
  expect(sent).toHaveLength(2)
  expect(sent[0]).toEqual(sent[1])
  expect(rebuilt.pendingCount()).toBe(0)
})

it('historical duplicate queued sale stays byte-identical while new physical sales are captured', () => {
  vi.stubGlobal('navigator', { onLine: false })
  const kv = memoryKV(), old: OutboxItem = { type: 'order', idempotencyKey: 'old:old-sale', seq: 7, status: 'failed', attempts: 5,
    clientCreatedAt: '2026-09-01T00:00:00Z', lastError: 'Historical evidence', payload: { promotionIds: ['P'], discountCodes: ['Raw-Winner', 'Second'], items: [line('buy', 1)] } }
  const bytes = JSON.stringify(old); kv.set('mandalika.pos.outbox', JSON.stringify([old]))
  const api: ApiLike = { async request() { throw new Error('No network') } }, engine = new SyncEngine(api, {}, kv), p = promo('bundle'), state = commit(initial(p), codeOwner(p))
  engine.enqueue('order', { items: state.cart, ...buildPromotionMetadata(state, price(state)) }, 'new-physical')
  expect(JSON.stringify(new SyncEngine(api, {}, kv).outbox.deadLettered()[0])).toBe(bytes)
})

it('shared server fixtures are produced by real direct/code fulfillment and queued metadata', () => {
  vi.stubGlobal('navigator', { onLine: false })
  const uuid = (n: number) => `00000000-0000-4000-8300-${String(n).padStart(12, '0')}`
  const catalog = [product(uuid(1), 100000), product(uuid(2), 20000)]
  const promotions: Promotion[] = [
    { ...promo('buy_x_get_y', uuid(3)), bxgyConfig: { ...promo('buy_x_get_y').bxgyConfig!, buyProductIds: [uuid(1)], getProductIds: [uuid(2)] } },
    { ...promo('bundle', uuid(4)), bundleConfig: { slots: [{ productKeys: [uuid(1)], quantity: 1 }, { productKeys: [uuid(2)], quantity: 1 }], bundlePrice: 105000 } },
  ]
  const kv = memoryKV(); kv.set('mandalika.pos.deviceId', uuid(99))
  const api: ApiLike = { async request() { throw new Error('No network in generator') } }
  const engine = new SyncEngine(api, {}, kv)
  const cases = []
  let seq = 0
  for (const p of promotions) {
    const start: CashierState = { ...CASHIER_INITIAL_STATE, cart: p.type === 'bundle' ? [line(uuid(1), 100000), line(uuid(2), 20000)] : [line(uuid(1), 100000)] }
    for (const kind of ['direct', 'code'] as const) {
      const raw = `Raw-LF-${p.type}`, owner = kind === 'direct' ? directOwner(p) : codeOwner(p, raw)
      const state = commit(start, owner, catalog), derived = price(state)
      expect(state.cart.filter(c => c.rewardPromotionId === p.id)).toHaveLength(1)
      const created = engine.enqueue('order', { items: state.cart, paymentMethod: 'cash', amountPaid: derived.total, ...buildPromotionMetadata(state, derived) }, uuid(100 + ++seq))
      const item = structuredClone(engine.outbox.all().find(i => i.idempotencyKey === created.idempotencyKey)!)
      cases.push({ name: `${p.type}-${kind}`, kind, promotionId: p.id, code: raw, expectedTotal: derived.total,
        expectedRewardNet: p.type === 'bundle' ? 5000 : 10000, expectedQuantities: { [uuid(1)]: 1, [uuid(2)]: 1 },
        expectedGrants: 1, item: { type: item.type, idempotencyKey: item.idempotencyKey, payload: item.payload } })
    }
  }
  // Stable generated file is the shared Go fixture. Runtime timestamps are
  // excluded only from this golden representation; the real queue keeps them.
  const fixture = { products: catalog, promotions, cases }
  for (const c of fixture.cases) delete c.item.payload.clientCreatedAt
  const output = process.env.MANDALIKA_LF_FIXTURE_OUTPUT
  if (output) writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n')
  const checkedIn = JSON.parse(readFileSync(new URL('../../../../backend/internal/handlers/testdata/linked_fulfillment_orders.json', import.meta.url), 'utf8'))
  expect(fixture).toEqual(checkedIn)
})
