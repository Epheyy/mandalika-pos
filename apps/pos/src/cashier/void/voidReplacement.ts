import type { components } from '@mandalika/api'
import { isCashMethod, type CashFlagMethod } from '@mandalika/types'
import type { BxgyRewardPick } from '../BxgyRewardModal'
import type { HeldAdjustment, HeldOrder } from '../heldOrders'
import type { TenderLine } from '../tenderSplit'
import type { VoidReasonCode } from './voidRules'

type Order = components['schemas']['Order']
type CartItem = components['schemas']['CartItem']

/** The open "Batalkan & perbaiki" / "Buat pengganti" flow: what is being voided and how its replacement settles. */
export interface VoidDraft {
  orderId: string
  saleOrderUuid?: string
  orderNumber: string
  originalTotal: number
  /** The original's payment lines as APPLIED amounts (what the store received). */
  originalTenders: TenderLine[]
  reason: VoidReasonCode
  note: string
  stockChoices: Record<string, 'restock' | 'skip_counted'>
  shiftId: string | null
  /** The server refuses a different amount (afterClose or another shift): the replacement always books the gap as a correction. */
  amountsLocked: boolean
  kind: 'void_and_replace' | 'create_replacement'
}

const adjustment = (type: string | null | undefined, value: number | null | undefined): HeldAdjustment =>
  (value ?? 0) > 0 ? { value: value as number, type: type === 'percentage' ? 'percentage' : 'fixed' } : { value: 0, type: 'fixed' }

const unique = (xs: string[]): string[] => [...new Set(xs.filter((x) => x !== ''))]

/** The voided sale as a cart draft, for the replacement. Same shape as a held order, so the existing planHeldRestore
 *  rebuilds it (bundle groups, customer, promotions, codes, manual discount/surcharge). Server row fields and per-line
 *  promo ids are dropped (the restore re-applies promotions); reward lines become `rewardPicks`. Auto promos cannot be
 *  told from manual ones on an Order, so they come back as manual promotions. The customer's phone and points are not on
 *  an Order (phone '', points 0) until the picker refreshes them. */
export function heldOrderFromVoidedOrder(order: Order, now: number): HeldOrder {
  const lines: CartItem[] = []
  const rewardPicks: Record<string, BxgyRewardPick[]> = {}
  const promoIds: string[] = []
  const codes: string[] = order.discountCode ? [order.discountCode] : []
  let loyaltyReward = false
  for (const it of order.items) {
    promoIds.push(...(it.promotionIds ?? []))
    codes.push(...(it.discountCodes ?? []))
    if (it.isReward) {
      if (it.rewardConditionId) loyaltyReward = true
      else if (it.rewardPromotionId) {
        const pick: BxgyRewardPick = { productId: it.productId, productName: it.productName, variantSize: it.variantSize, net: it.price }
        rewardPicks[it.rewardPromotionId] = [...(rewardPicks[it.rewardPromotionId] ?? []), ...Array.from({ length: it.quantity }, () => pick)]
      }
      continue
    }
    const { id: _id, lineNo: _lineNo, netAmount: _net, refundGroup: _group, refundedQty: _qty, promotionIds: _p, discountCodes: _c, ...line } = it
    void [_id, _lineNo, _net, _group, _qty, _p, _c]
    lines.push(line)
  }
  const discount = adjustment(order.discountType, order.discountValue)
  return {
    v: 1,
    id: `void-${order.id}`,
    name: `Pengganti #${order.orderNumber}`,
    heldAt: now,
    lines,
    customer: order.customerId ? { id: order.customerId, name: order.customerName ?? '', phone: '', points: 0 } : null,
    salesman: order.salesmanId ? { id: order.salesmanId, name: order.salesmanName ?? '' } : null,
    notes: order.notes ?? '',
    discount,
    surcharge: adjustment(order.surchargeType, order.surchargeValue),
    stagedDiscountType: discount.type,
    promotions: unique(promoIds).map((id) => ({ id, name: id })),
    codes: unique(codes),
    rewardPicks,
    loyaltyDropped: (order.pointsRedeemed ?? 0) > 0 || loyaltyReward,
  }
}

/** The replacement starts with the original's applied payment lines (a copy). */
export function initialReplacementTenders(d: VoidDraft): TenderLine[] {
  return d.originalTenders.map((t) => ({ ...t }))
}

/** For a locked draft the replacement's lines must be the amounts APPLIED: the server refuses a cash line that still
 *  carries change. Trims the excess over `due` from cash lines (last first); other lines are left as they are. */
export function lockedReplacementTenders(tenders: readonly TenderLine[], due: number, methods?: readonly CashFlagMethod[]): TenderLine[] {
  const out = tenders.map((t) => ({ ...t }))
  let excess = out.reduce((n, t) => n + t.amount, 0) - due
  for (let k = out.length - 1; k >= 0 && excess > 0; k--) {
    if (!isCashMethod(methods, out[k].method)) continue
    const cut = Math.min(excess, out[k].amount)
    out[k] = { ...out[k], amount: out[k].amount - cut }
    excess -= cut
  }
  const kept = out.filter((t) => t.amount > 0)
  return kept.length > 0 ? kept : out
}

/** "adjust" (or a locked draft) books the gap between the original total and the cart as Penyesuaian koreksi. */
export function replacementCorrection(
  d: VoidDraft, cartTotal: number, choice: 'adjust' | 'settle',
): { correctionTarget?: 'original_total'; correction: number } {
  if (choice === 'adjust' || d.amountsLocked) return { correctionTarget: 'original_total', correction: d.originalTotal - cartTotal }
  return { correction: 0 }
}
