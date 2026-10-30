import { useEffect, useRef, useState, type Dispatch } from 'react'
import { draftBelongsToSale, draftIsAlreadyASale, getSplitDraftStore, splitDraftFromState, type SplitDraft } from './splitDraft'
import { planHeldRestore, type HeldRestoreEnv } from './heldRestore'
import type { CashierAction, CashierState } from './state/cashierReducer'

interface Options {
  outletId: string
  state: CashierState
  /** The order total now (after points), kept in the draft for the banner. */
  total: number
  dispatch: Dispatch<CashierAction>
  isCash: (method: string) => boolean
  defaultMethod: string
  getEnv: () => HeldRestoreEnv
  /** Every sale uuid this tablet already holds (outbox rows and archived receipts). */
  saleUuids: () => ReadonlySet<string>
  /** Same gates as adding to the cart (an open shift, the 12 h offline lock): restore re-opens a SALE, so it needs them too. */
  ensureShift: () => boolean
  offlineLock: () => string | null
  showToast: (msg: string) => void
}

/**
 * D-62: keeps the unfinished split payment on this tablet while it exists, and offers it back after a restart.
 * The draft follows the state (saved when a non-cash line is entered, removed when none is left); `clearNow` is the
 * explicit delete the sale gate runs right after the enqueue resolves.
 */
export function useSplitDraft({ outletId, state, total, dispatch, isCash, defaultMethod, getEnv, saleUuids, ensureShift, offlineLock, showToast }: Options) {
  const store = getSplitDraftStore(outletId)
  const [pending, setPending] = useState<SplitDraft | null>(() => {
    const found = store.read()
    return found && !draftIsAlreadyASale(found, saleUuids()) ? found : null
  })
  // A draft whose sale was already queued (the kill landed between the enqueue and the delete): drop it, no prompt.
  useEffect(() => {
    const found = store.read()
    if (found && draftIsAlreadyASale(found, saleUuids())) void store.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount: later changes are this hook's own writes
  }, [])

  const kept = useRef(false)
  const toastWriteFailed = () => showToast('Pembayaran terpisah belum tersimpan di tablet ini. Jangan tutup aplikasi sebelum Konfirmasi.')
  useEffect(() => {
    const draft = splitDraftFromState(state, total, isCash, Date.now())
    if (draft) {
      kept.current = true
      store.save(draft).catch(toastWriteFailed)
    } else if (kept.current) {
      kept.current = false
      void store.clear().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the lines, not every render
  }, [state.splitMode, state.tenders, state.splitOrderUuid, state.cart, state.pointsToRedeem, total])

  /** The sale-gate delete: only the draft OF THIS sale. A plain sale rung up while another draft is pending leaves it. */
  const clearForSale = async (orderUuid: string): Promise<void> => {
    if (!draftBelongsToSale(store.read(), orderUuid)) return
    kept.current = false
    setPending(null)
    await store.clear().catch(() => {})
  }

  const restore = (): void => {
    if (!pending) return
    if (!ensureShift()) return
    const locked = offlineLock()
    if (locked) { showToast(locked); return }
    const plan = planHeldRestore(pending.held, getEnv())
    for (const action of plan.actions) dispatch(action)
    dispatch({ type: 'OPEN_CHECKOUT', defaultMethod })
    dispatch({ type: 'SPLIT_RESTORE', orderUuid: pending.orderUuid, tenders: pending.tenders })
    kept.current = true
    setPending(null)
    if (plan.notes.length > 0) showToast(plan.notes.join('\n'))
  }

  const discard = (): void => {
    kept.current = false
    setPending(null)
    void store.clear().catch(() => {})
  }

  return { pending, restore, discard, clearForSale }
}
