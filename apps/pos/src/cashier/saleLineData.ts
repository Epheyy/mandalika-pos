import type { components } from '@mandalika/api'
import { allocateNet, type AllocComponent } from './allocateNet'
import { calcPromoDiscount, keyMatchesLine, linkedPromoShape } from './pricing'
import { effectivePromotionSelection } from './promotionSelection'
import type { AppliedPromoCode } from './promoValidate'

// C4b: the per-line facts a sale carries so a LATER partial refund of a sale that has not synced yet can be
// priced on the tablet: each line's net share (allocateNet) and its promo group. The server stores its own
// allocation (service/allocate.go) and ignores these keys for money; a refund of a synced sale reads the server's.
// This file mirrors DiscountComponents / promoEligibleLines / refundGroups of the Go allocator (golden notes in
// backend/internal/service/testdata/allocate_golden.json). If the two ever disagree the claimed refund amount is
// accepted and flagged by the server, never blocked, and the server caps it (D-49).

type Promotion = components['schemas']['Promotion']
type CartItem = components['schemas']['CartItem']

/** Go math.Round: half away from zero. */
const roundRupiah = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v))

const sameProduct = (ids: readonly string[], i: CartItem): boolean => ids.includes(i.productId)

/** Positions of the lines a promo's discount is attributed to, or null for "every line". */
function promoEligibleLines(p: Promotion, items: readonly CartItem[]): number[] | null {
  const pick = (match: (i: CartItem) => boolean): number[] => items.flatMap((i, idx) => (match(i) ? [idx] : []))
  if (p.type === 'buy_x_get_y') {
    const buy = p.bxgyConfig?.buyProductIds ?? []
    return buy.length === 0 ? null : pick((i) => keyMatchesLine(buy, i.productId, i.variantSize))
  }
  if (p.type === 'tiered' || p.type === 'bundle') return null
  const scope = p.applicableProductIds ?? []
  return scope.length === 0 ? null : pick((i) => sameProduct(scope, i))
}

/** An unlinked code is a flat percentage / fixed discount off the whole cart. */
function codeAsPromotion(c: AppliedPromoCode): Promotion {
  if (c.promotion) return linkedPromoShape(c)
  return { id: '', name: c.code, type: c.type, value: c.value, isActive: true, createdAt: '' } as Promotion
}

export interface SaleLineDataInput {
  /** The cart exactly as sent (payload order = lineNo). Reward lines are already net-priced. */
  cart: readonly CartItem[]
  appliedPromotions: readonly Promotion[]
  appliedPromoCodes: readonly AppliedPromoCode[]
  discountType: 'percentage' | 'fixed'
  discountRunning: number
  /** The stored order total: after tax, surcharge, rounding and redeemed points. */
  total: number
  /** Every promotion the tablet knows, so a reward line can be traced to its config. */
  knownPromotions: readonly Promotion[]
  /** Called when the allocator throws (a bug or a malformed promotion config); the sale itself still goes through. */
  onError?: (error: unknown) => void
}

/** The order-level discount components in the order the allocator spreads them: each promo then each code
 *  (stack order), then the manual discount, the running sum capped at the cart subtotal. */
export function discountComponents(i: Pick<SaleLineDataInput, 'cart' | 'appliedPromotions' | 'appliedPromoCodes' | 'discountType' | 'discountRunning'>): AllocComponent[] {
  const cart = i.cart as CartItem[]
  const subtotal = cart.reduce((s, l) => s + l.subtotal, 0)
  let budget = roundRupiah(subtotal)
  const out: AllocComponent[] = []
  const add = (amount: number, eligible: number[] | null) => {
    const a = Math.min(roundRupiah(amount), budget)
    if (a <= 0) return
    budget -= a
    out.push({ amount: a, eligible })
  }
  const { appliedPromotions, appliedPromoCodes } = effectivePromotionSelection([...i.appliedPromotions], [...i.appliedPromoCodes])
  for (const p of [...appliedPromotions, ...appliedPromoCodes.map(codeAsPromotion)]) {
    const amount = calcPromoDiscount(p, cart, subtotal)
    if (amount > 0) add(amount, promoEligibleLines(p, cart))
  }
  if (i.discountRunning > 0) {
    const manual = i.discountType === 'percentage'
      ? Math.round(subtotal * (i.discountRunning / 100))
      : Math.min(i.discountRunning, subtotal)
    add(manual, null)
  }
  return out
}

interface GroupInfo { kind: 'bundle' | 'bxgy'; promoId: string; promo: Promotion; key: string }

function paidLineInGroup(g: GroupInfo, it: CartItem): boolean {
  if (g.kind === 'bundle') return (g.promo.bundleConfig?.slots ?? []).some((s) => keyMatchesLine(s.productKeys, it.productId, it.variantSize))
  const c = g.promo.bxgyConfig
  if (!c) return false
  const buy = c.buyProductIds ?? []
  if (buy.length > 0) return keyMatchesLine(buy, it.productId, it.variantSize)
  return !keyMatchesLine(c.getProductIds ?? [], it.productId, it.variantSize)
}

/** Per line, the refund group key ("<kind>:<promotionId>:1") or null. One group per promo reward in the sale,
 *  holding its reward line(s) plus the paid lines on its buy side; groups that share a paid line merge, and every
 *  member takes the lexicographically smallest key. Loyalty reward lines carry no group (D-35). */
export function refundGroups(cart: readonly CartItem[], promoById: (id: string) => Promotion | undefined): (string | null)[] {
  const out = new Array<string | null>(cart.length).fill(null)
  const groups: GroupInfo[] = []
  const byPromo = new Map<string, number>()
  for (const it of cart) {
    if (!it.isReward || !it.rewardPromotionId || byPromo.has(it.rewardPromotionId)) continue
    const promo = promoById(it.rewardPromotionId)
    if (!promo || (promo.type !== 'bundle' && promo.type !== 'buy_x_get_y')) continue
    const kind = promo.type === 'bundle' ? 'bundle' : 'bxgy'
    byPromo.set(promo.id, groups.length)
    groups.push({ kind, promoId: promo.id, promo, key: `${kind}:${promo.id}:1` })
  }
  if (groups.length === 0) return out
  const parent = groups.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const matches: number[][] = cart.map((it) => (it.isReward ? [] : groups.flatMap((g, gi) => (paidLineInGroup(g, it) ? [gi] : []))))
  for (const m of matches) for (const gi of m.slice(1)) parent[find(gi)] = find(m[0])
  const rootKey = new Map<number, string>()
  groups.forEach((g, gi) => {
    const r = find(gi)
    const k = rootKey.get(r)
    if (k === undefined || g.key < k) rootKey.set(r, g.key)
  })
  const keyOf = (gi: number): string => rootKey.get(find(gi)) as string
  cart.forEach((it, i) => {
    if (it.isReward) {
      const gi = it.rewardPromotionId ? byPromo.get(it.rewardPromotionId) : undefined
      if (gi !== undefined) out[i] = keyOf(gi)
    } else if (matches[i].length > 0) {
      out[i] = keyOf(matches[i][0])
    }
  })
  return out
}

/** The cart with `netAmount` / `refundGroup` on every line, ready for the sale payload, or null when no valid
 *  allocation exists (a sale that then refunds whole-order only, exactly as the server decides for its own). */
export function withSaleLineData(i: SaleLineDataInput): CartItem[] | null {
  // Optional extra data: a malformed promotion config must never fail the sale it rides on.
  try {
    return buildSaleLineData(i)
  } catch (error) {
    i.onError?.(error)
    return null
  }
}

function buildSaleLineData(i: SaleLineDataInput): CartItem[] | null {
  const lines = i.cart.map((l, idx) => ({ lineNo: idx, base: roundRupiah(l.subtotal) }))
  const total = Number.isFinite(i.total) && Math.abs(i.total - Math.round(i.total)) <= 0.004 ? Math.round(i.total) : NaN
  if (!Number.isSafeInteger(total)) return null
  const nets = allocateNet({ lines, components: discountComponents(i), total })
  if (!nets) return null
  const byId = new Map<string, Promotion>()
  for (const p of [...i.knownPromotions, ...i.appliedPromotions, ...i.appliedPromoCodes.flatMap((c) => (c.promotion ? [linkedPromoShape(c)] : []))]) byId.set(p.id, p)
  const groups = refundGroups(i.cart, (id) => byId.get(id))
  return i.cart.map((l, idx) => ({ ...l, netAmount: nets[idx], refundGroup: groups[idx] }) as CartItem)
}
