import type { components } from '@mandalika/api'
import type { VoidSlipData } from '@mandalika/printer'
import type { CashFlagMethod, Shift } from '@mandalika/types'
import { planHeldRestore, type HeldRestoreEnv } from '../heldRestore'
import type { CashierAction } from '../state/cashierReducer'
import { SPLIT_METHOD_ID, type SalePlan, type TenderLine } from '../tenderSplit'
import { heldOrderFromVoidedOrder, isLocked, lockedReplacementTenders, lockedTendersProblem, replacementCorrection, type VoidDraft } from './voidReplacement'
import { buildVoidPayload, voidAvailability, VOID_REASONS, type VoidAvailabilityInput } from './voidRules'

type Order = components['schemas']['Order']
type OkPlan = Extract<SalePlan, { ok: true }>

// The commit side of a void replacement cart (Void phase 3). Pure except `commitVoidDraftSale`, which only calls the
// engine it is given. The invariant: nothing is voided until ONE `void` outbox item is durably queued; abandoning the
// cart, a restart or a shift close before that leaves the original sale untouched.

/** Toast when a draft is dropped because the void can no longer be made. */
export const voidDroppedMessage = (orderNumber: string): string => `Pembatalan tidak jadi: transaksi #${orderNumber} tetap tercatat.`

export interface VoidStartContext {
  /** Fresh uuid of the replacement sale: also the key of the `void` item, so a retry is the same item. */
  replacementUuid: string
  /** The open shift's id now (null with no shift). Confirm refuses once the open shift is another one. */
  shiftId: string | null
  now?: number
}

/** Reducer actions that open the replacement cart of `order`: the held-order restore (re-priced from today's
 *  catalogue), then VOID_DRAFT_START. The draft marker goes LAST because the restore's first action is CART_CLEAR,
 *  which drops any draft. The original's payment lines are seeded by OPEN_CHECKOUT (it wipes split lines otherwise). */
export function startVoidDraftActions(order: Order, draft: VoidDraft, env: HeldRestoreEnv, ctx: VoidStartContext): { actions: CashierAction[]; notes: string[]; lossless: boolean } {
  const plan = planHeldRestore(heldOrderFromVoidedOrder(order, ctx.now ?? Date.now()), env)
  const started: VoidDraft = { ...draft, replacementUuid: ctx.replacementUuid, startedShiftId: ctx.shiftId, sale: draft.sale ?? order }
  return { actions: [...plan.actions, { type: 'VOID_DRAFT_START', draft: started }], notes: plan.notes, lossless: plan.lossless }
}

/** What the replacement is due: the original total when the gap is booked as Penyesuaian koreksi (adjust or locked),
 *  else the cart's own total. `correction` is the signed amount added to the cart total (original - cart). */
export function voidPayable(draft: VoidDraft | null, choice: 'adjust' | 'settle', cartTotal: number): { correction: number; payable: number; correctionTarget?: 'original_total' } {
  if (!draft) return { correction: 0, payable: cartTotal }
  const r = replacementCorrection(draft, cartTotal, choice)
  return { ...r, payable: cartTotal + r.correction }
}

/** Why this draft can no longer be committed (the toast text), or null. An own-shift void must still be in the shift
 *  it began in, and that shift must still be open: the server refuses otherwise (ErrVoidShiftClosed), so the tablet
 *  never queues it. */
export function voidDraftRefusal(draft: VoidDraft, currentShift: Pick<Shift, 'id' | 'status'> | null, gate?: Omit<VoidAvailabilityInput, 'order'>): string | null {
  const dropped = voidDroppedMessage(draft.orderNumber)
  // A draft that lost its original can never build the void: refuse before a number is burned.
  if (!draft.sale && draft.kind !== 'create_replacement') return dropped
  if (draft.kind !== 'create_replacement') {
    const id = currentShift?.id ?? ''
    const open = !!currentShift && currentShift.status === 'open' && id !== ''
    const sameShift = draft.startedShiftId !== undefined && draft.startedShiftId === id && (draft.shiftId === null || draft.shiftId === id)
    if (!(open && sameShift)) return dropped
  }
  // The sale may have been voided, refunded or replaced since the cart opened (this tablet or a synced ack): a second
  // void would be refused as already voided and the paid replacement parked. `gate` is read fresh by the caller.
  if (gate && draft.sale) {
    const want = draft.kind === 'create_replacement' ? 'create_replacement' : 'void'
    if (voidAvailability({ order: draft.sale, ...gate, draftOpen: false }).kind !== want) return dropped
  }
  return null
}

/** A locked draft sends the amounts APPLIED (never tendered / change). Keeps the plan's shape. */
export function applyLockedTenders(plan: OkPlan, draft: VoidDraft, methods?: readonly CashFlagMethod[]): OkPlan {
  if (!isLocked(draft)) return plan
  const lines: TenderLine[] = lockedReplacementTenders(plan.lines, draft.originalTotal, methods)
  const amountPaid = lines.reduce((n, l) => n + l.amount, 0)
  return { ...plan, lines, amountPaid, change: 0, paymentMethod: lines.length > 1 ? SPLIT_METHOD_ID : (lines[0]?.method ?? plan.paymentMethod), split: lines.length > 1 }
}

export interface VoidEngine {
  enqueue(type: 'void' | 'order', payload: Record<string, unknown>, orderUuid: string): Promise<{ idempotencyKey: string; orderUuid: string }>
}

export type VoidCommit =
  | { status: 'queued'; type: 'void' | 'order'; orderUuid: string }
  | { status: 'refused'; message: string; dropDraft: boolean }

export interface VoidCommitInput {
  engine: VoidEngine
  draft: VoidDraft
  currentShift: Pick<Shift, 'id' | 'status'> | null
  /** The exact `order` payload the plain sale path would queue (buildSaleOrderPayload), built from the applied plan. */
  orderPayload: Record<string, unknown>
  /** The uuid of the replacement sale: the cart's own, kept for retries. */
  saleUuid: string
  choice: 'adjust' | 'settle'
  cartTotal: number
  methods?: readonly CashFlagMethod[]
  /** Fresh availability inputs (queues, synced voids, shift): the draft is dropped when its sale no longer permits it. */
  gate?: Omit<VoidAvailabilityInput, 'order'>
}

/** Queues the replacement cart. ONE outbox item: a `void` carrying the replacement (void_and_replace), or an `order`
 *  with replacesOrderId (create_replacement, the original is already voided). Refuses, queuing nothing, when the shift
 *  is gone or a locked draft's payment lines are not exactly what the store received. Run it inside the sale gate. */
export async function commitVoidDraftSale(i: VoidCommitInput): Promise<VoidCommit> {
  const { draft } = i
  const refusal = voidDraftRefusal(draft, i.currentShift, i.gate)
  if (refusal) return { status: 'refused', message: refusal, dropDraft: true }
  if (isLocked(draft)) {
    const problem = lockedTendersProblem((i.orderPayload.tenders ?? []) as TenderLine[], draft.originalTotal)
    if (problem) return { status: 'refused', message: problem, dropDraft: false }
  }
  const { correctionTarget } = voidPayable(draft, i.choice, i.cartTotal)
  if (draft.kind === 'create_replacement') {
    // replacesOrderNumber is display only (the reprint's "Pengganti untuk" line); the server ignores it.
    const payload = { ...i.orderPayload, replacesOrderId: draft.orderId, replacesOrderNumber: draft.orderNumber, correctionTarget: 'original_total', shiftId: draft.shiftId }
    await i.engine.enqueue('order', payload, i.saleUuid)
    return { status: 'queued', type: 'order', orderUuid: i.saleUuid }
  }
  if (!draft.sale) return { status: 'refused', message: voidDroppedMessage(draft.orderNumber), dropDraft: true }
  const payload = buildVoidPayload({
    order: draft.sale, reason: draft.reason, note: draft.note, mode: 'replace', stockChoices: draft.stockChoices,
    replacement: { ...i.orderPayload, orderUuid: i.saleUuid, ...(correctionTarget ? { correctionTarget } : {}) },
    methods: i.methods, giveaway: draft.giveaway, previewLines: draft.previewLines,
  })
  await i.engine.enqueue('void', payload, i.saleUuid)
  return { status: 'queued', type: 'void', orderUuid: i.saleUuid }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** The DIBATALKAN slip: of a void_and_replace commit (the replacement's number is known: it was just rung), or of a
 *  "Batalkan saja" (no `replacementRef`). */
export function voidSlipData(i: { draft: Pick<VoidDraft, 'orderNumber' | 'originalTotal' | 'reason' | 'note'>; voidedBy: string; replacementRef?: string; at: Date }): VoidSlipData {
  const { draft, at } = i
  const label = VOID_REASONS.find((r) => r.code === draft.reason)?.label ?? draft.reason
  const note = draft.note.trim()
  return {
    orderRef: draft.orderNumber,
    total: draft.originalTotal,
    reasonLabel: label,
    ...(note ? { note } : {}),
    voidedBy: i.voidedBy,
    dateTime: `${two(at.getDate())}/${two(at.getMonth() + 1)}/${at.getFullYear()} ${two(at.getHours())}:${two(at.getMinutes())}`,
    ...(i.replacementRef ? { replacementRef: i.replacementRef } : {}),
  }
}
