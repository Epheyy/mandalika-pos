import type { components } from '@mandalika/api'
import type { buildPromotionMetadata } from './promotionMetadata'
import type { ReceiptQuote } from './receiptQuote'
import type { CashierState } from './state/cashierReducer'
import { salePaymentFields, type SalePlan } from './tenderSplit'

type CartItem = components['schemas']['CartItem']

export interface SalePayloadInput {
  orderNumber: string
  /** The cart lines with their net share and promo group (withSaleLineData). */
  items: CartItem[]
  plan: Extract<SalePlan, { ok: true }>
  state: Pick<CashierState, 'selectedCustomer' | 'selectedSalesman' | 'discountRunning' | 'appliedDiscountType' | 'surchargeRunning' | 'appliedSurchargeType' | 'orderNotes'>
  promotionMetadata: ReturnType<typeof buildPromotionMetadata>
  redeemedPoints: number
  /** '' = the open shift has not synced yet. */
  shiftId: string | null
  quote: ReceiptQuote
}

/** The `order` outbox payload of a sale. The ONE builder: a plain sale queues it as an `order`, a void replacement
 *  nests it (plus orderUuid and correctionTarget) inside a `void`, so both price and describe the cart identically. */
export function buildSaleOrderPayload(i: SalePayloadInput): Record<string, unknown> {
  const { state } = i
  return {
    orderNumber: i.orderNumber,
    items: i.items,
    ...salePaymentFields(i.plan),
    customerId: state.selectedCustomer?.id ?? null,
    customerName: state.selectedCustomer?.name ?? null,
    salesmanId: state.selectedSalesman?.id ?? null,
    salesmanName: state.selectedSalesman?.name ?? null,
    discountType: state.discountRunning > 0 ? state.appliedDiscountType : null,
    discountValue: state.discountRunning > 0 ? state.discountRunning : null,
    surchargeValue: state.surchargeRunning > 0 ? state.surchargeRunning : null,
    surchargeType: state.surchargeRunning > 0 ? state.appliedSurchargeType : null,
    ...i.promotionMetadata,
    pointsRedeemed: i.redeemedPoints > 0 ? i.redeemedPoints : null,
    notes: state.orderNotes.trim() || null,
    shiftId: i.shiftId,
    quotedTotal: i.quote.quotedTotal,
    receiptSnapshot: i.quote.receiptSnapshot,
  }
}
