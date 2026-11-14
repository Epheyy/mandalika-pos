import type { components } from '@mandalika/api'
import type { CashFlagMethod } from '@mandalika/types'
import type { BxgyRewardPick } from '../BxgyRewardModal'
import type { HeldAdjustment, HeldOrder } from '../heldOrders'
import type { TenderLine } from '../tenderSplit'
import { appliedTenders, type LocalVoidSale, type VoidReasonCode } from './voidRules'

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
  /** Set by startVoidDraftActions. The replacement sale's order uuid: also the void item's key. saleUuidFor prefers it, so
   *  it stays the same across split cancel / a new split / retries. */
  replacementUuid?: string
  /** Set by startVoidDraftActions: the open shift's id when the draft began. Confirm refuses once it is not the open shift. */
  startedShiftId?: string | null
  /** Set by startVoidDraftActions: the original as the history row knew it (an Order, or a LocalVoidSale for a sale not
   *  synced yet). It feeds buildVoidPayload (restockLines, originalTenders, orderId or saleOrderUuid). */
  sale?: Order | LocalVoidSale
  /** The outlet giveaway unit the original took, when the caller knows it (an Order's items do not carry it). Only
   *  feeds the tablet's stock overlay; the server decides stock itself. Leave unset when unsure. */
  giveaway?: { productId: string; variantSize: string } | null
  /** The preview's counted lines, kept so the void payload can leave skip_counted lines out of the stock overlay. */
  previewLines?: { key: string; productId: string; variantSize: string; quantity: number }[]
}

const adjustment = (type: string | null | undefined, value: number | null | undefined): HeldAdjustment =>
  (value ?? 0) > 0 ? { value: value as number, type: type === 'percentage' ? 'percentage' : 'fixed' } : { value: 0, type: 'fixed' }

const unique = (xs: string[]): string[] => [...new Set(xs.filter((x) => x !== ''))]

/** "bxgy:<promoId>:1" / "bundle:<promoId>:1" (backend allocate.go groupKey) -> promoId, else null. */
const promoOfGroup = (group: string | null | undefined): string | null => {
  const m = /^(?:bxgy|bundle):([^:]+):\d+$/.exec(group ?? '')
  return m ? m[1] : null
}

/** The voided sale as a cart draft, for the replacement. Same shape as a held order, so the existing planHeldRestore
 *  rebuilds it. Built ONLY from what the order read JSON really carries (backend/internal/read/orders.go):
 *  - set-bundle pieces keep their bundle fields (bundleGroup/Role/Line/Size); the restore re-prices them from today's offer;
 *  - a Rp0 line outside a set bundle whose refundGroup is `bxgy:<promo>:1` / `bundle:<promo>:1` is that promotion's
 *    gift: it becomes rewardPicks[promo] and the promotion is re-installed; any other line of such a group only adds
 *    its promotion; a Rp0 line with no group is a loyalty reward: dropped, loyaltyDropped (the restore says so);
 *  - only the first discount code (`discountCode`) is stored on an order; the restore notes that more must be re-applied;
 *  - promotions are not named on an Order, and auto promos cannot be told from manual ones, so all come back as manual;
 *  - the customer comes back as id + name only (no phone, points or segment), with a restore note to pick again. */
export function heldOrderFromVoidedOrder(order: Order, now: number): HeldOrder {
  const lines: CartItem[] = []
  const rewardPicks: Record<string, BxgyRewardPick[]> = {}
  const promoIds: string[] = []
  const codes: string[] = order.discountCode ? [order.discountCode] : []
  let loyaltyReward = false
  for (const it of order.items) {
    // The outlet giveaway of a local receipt (flagged by localReceiptOrder) is added by the server again, never re-rung.
    if ((it as { isGiveaway?: boolean }).isGiveaway) continue
    const inSet = it.bundleGroup != null
    const promoId = inSet ? null : promoOfGroup(it.refundGroup)
    if (promoId) promoIds.push(promoId)
    if (!inSet && it.price === 0) {
      if (promoId) {
        const pick: BxgyRewardPick = { productId: it.productId, productName: it.productName, variantSize: it.variantSize, net: 0 }
        rewardPicks[promoId] = [...(rewardPicks[promoId] ?? []), ...Array.from({ length: it.quantity }, () => pick)]
      } else loyaltyReward = true
      continue
    }
    const { id: _id, lineNo: _lineNo, netAmount: _net, refundGroup: _group, refundedQty: _qty, ...line } = it
    void [_id, _lineNo, _net, _group, _qty]
    lines.push(line)
  }
  const discount = adjustment(order.discountType, order.discountValue)
  const restoreNotes: string[] = []
  if (order.customerId) restoreNotes.push('Pilih ulang pelanggan agar poin dan segmen terbaru terpasang')
  if (order.discountCode) restoreNotes.push('Kode Promo lain (jika ada) harus dipasang ulang di Promo & Diskon')
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
    ...(restoreNotes.length > 0 ? { restoreNotes } : {}),
  }
}

/** Whether the replacement must pay exactly what the store received. "Buat pengganti" is always locked (the server
 *  forces it), whatever the draft's flag says. */
export const isLocked = (d: Pick<VoidDraft, 'amountsLocked' | 'kind'>): boolean => d.amountsLocked || d.kind === 'create_replacement'

/** The replacement starts with the original's applied payment lines (a copy). */
export function initialReplacementTenders(d: VoidDraft): TenderLine[] {
  return d.originalTenders.map((t) => ({ ...t }))
}

/** For a locked draft the replacement's lines must be the amounts APPLIED: the server refuses a cash line that still
 *  carries change. Trims the excess over `originalTotal` from cash lines (the same rule as the original tenders). */
export function lockedReplacementTenders(tenders: readonly TenderLine[], originalTotal: number, methods?: readonly CashFlagMethod[]): TenderLine[] {
  return appliedTenders(tenders, originalTotal, methods)
}

const groupThousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/** The server's ErrVoidAmountsLocked text when the applied lines do not add up to what the store received (so 3.3 can
 *  block confirm), else null. Compared in whole cents like the server's tender rules. */
export function lockedTendersProblem(tenders: readonly TenderLine[], originalTotal: number): string | null {
  const sum = tenders.reduce((n, t) => n + Math.round(t.amount * 100), 0)
  if (sum === Math.round(originalTotal * 100)) return null
  return `Jumlah pembayaran pengganti harus sama dengan yang diterima (Rp ${groupThousands(originalTotal)}).`
}

/** "adjust" (or a locked draft) books the gap between the original total and the cart as Penyesuaian koreksi.
 *  `cartTotal` is the amount due after points redemption (what the order payload's total will be); whole rupiah. */
export function replacementCorrection(
  d: VoidDraft, cartTotal: number, choice: 'adjust' | 'settle',
): { correctionTarget?: 'original_total'; correction: number } {
  if (choice === 'adjust' || isLocked(d)) return { correctionTarget: 'original_total', correction: d.originalTotal - Math.round(cartTotal) }
  return { correction: 0 }
}

/** Whether this draft is the one about `keys` (a sale's server id and/or client uuid). */
export const voidDraftNames = (d: Pick<VoidDraft, 'orderId' | 'saleOrderUuid'> | null, keys: readonly (string | undefined)[]): boolean =>
  !!d && keys.some((k) => !!k && (k === d.orderId || k === d.saleOrderUuid))

/** Whether a new "Batalkan & perbaiki" draft starts with locked amounts: the preview decides when there is one; without
 *  it (offline) a sale with no shift id (O5) is server-forced to locked, so it starts locked. */
export const defaultAmountsLocked = (preview: { amountsLocked: boolean } | null, sale: { shiftId?: string | null }): boolean =>
  preview ? preview.amountsLocked : !sale.shiftId
