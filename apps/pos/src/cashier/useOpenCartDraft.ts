import { useEffect, useRef, type Dispatch } from 'react'
import { planHeldRestore, type HeldRestoreEnv } from './heldRestore'
import { decideHydration, getOpenCartStore, openCartFromState, restoreToast, revalidationDelta } from './openCartDraft'
import type { CashierAction, CashierState } from './state/cashierReducer'

interface Options {
  outletId: string
  userId: string | null
  state: CashierState
  dispatch: Dispatch<CashierAction>
  getEnv: () => HeldRestoreEnv
  /** The catalogue is loaded: hydrating against an empty one would drop every line. */
  catalogueReady: boolean
  /** Order uuid of the waiting split-payment draft, if any: when it is this cart's sale it holds the charged lines and owns the restore. */
  splitDraftOrderUuid: string | null
  /** Every sale uuid this tablet already holds (outbox rows and archived receipts). */
  saleUuids: () => ReadonlySet<string>
  showToast: (msg: string) => void
}

/**
 * P-20: keeps the open cart on this tablet and puts it back after a reload. The draft follows the state (written on
 * every cart change, removed when the cart is empty or the sale's success view is open). `commitBeforeSale` and
 * `clearForSale` are the explicit steps the sale gate runs around the enqueue.
 */
export function useOpenCartDraft({ outletId, userId, state, dispatch, getEnv, catalogueReady, splitDraftOrderUuid, saleUuids, showToast }: Options) {
  const store = getOpenCartStore(outletId)
  // Writes stay off until the start-up decision is made, or the empty initial cart would erase the draft.
  const hydrated = useRef(false)
  const uuidRef = useRef<string | null>(null)
  // Until a cart has been seen this mount, an empty cart is just the pre-restore render: it must not erase the draft.
  const sawCart = useRef(false)

  const mintUuid = (): string => (uuidRef.current ??= crypto.randomUUID())
  /** The uuid the sale of THIS cart must use: the split draft's when split mode owns one, else the cart's own. */
  const saleUuidFor = (s: Pick<CashierState, 'splitMode' | 'splitOrderUuid'>): string =>
    s.splitMode && s.splitOrderUuid ? s.splitOrderUuid : mintUuid()

  useEffect(() => {
    if (hydrated.current || !catalogueReady || !userId) return
    hydrated.current = true
    const draft = store.read()
    if (!draft || decideHydration(draft, { userId, saleUuids: saleUuids(), splitDraftOrderUuid }) === 'drop') {
      void store.clear().catch(() => {})
      return
    }
    const env = getEnv()
    const plan = planHeldRestore(draft.held, env)
    uuidRef.current = draft.saleUuid
    for (const action of plan.actions) dispatch(action)
    // Nothing of it could come back (every line retired): no point keeping the draft.
    if (plan.result.cart.length === 0) void store.clear().catch(() => {})
    const toast = restoreToast(revalidationDelta(draft.held, env.products), plan.notes)
    if (toast) showToast(toast)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the catalogue and the account are known
  }, [catalogueReady, userId])

  useEffect(() => {
    if (!hydrated.current) return
    if (state.cart.length > 0) sawCart.current = true
    else if (!sawCart.current) return
    const draft = openCartFromState(state, { saleUuid: saleUuidFor(state), userId: userId ?? '', now: Date.now() })
    if (draft) {
      store.save(draft).catch(() => {})
    } else if (!state.isSuccessOpen) {
      // An empty cart ends this sale's identity: the next cart gets a fresh uuid.
      if (state.cart.length === 0) uuidRef.current = null
      void store.clear().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the sale content, not every render
  }, [state.cart, state.selectedCustomer, state.selectedSalesman, state.pointsToRedeem, state.orderNotes, state.discountRunning, state.surchargeRunning,
    state.appliedDiscountType, state.appliedSurchargeType, state.discountType, state.appliedPromotions, state.appliedPromoCodes, state.bundleFreed,
    state.splitMode, state.splitOrderUuid, state.isSuccessOpen])

  /** Before the enqueue: the draft on disk carries the uuid the sale is about to use (best effort: a failed write does not block the sale). */
  const commitBeforeSale = async (orderUuid: string): Promise<void> => {
    const draft = openCartFromState(state, { saleUuid: orderUuid, userId: userId ?? '', now: Date.now() })
    if (draft) await store.save(draft).catch(() => {})
  }

  /** Right after the enqueue resolved: this sale is queued, so its draft goes and the cart's identity rotates. */
  const clearForSale = async (): Promise<void> => {
    uuidRef.current = null
    await store.clear().catch(() => {})
  }

  return { saleUuidFor, commitBeforeSale, clearForSale }
}
