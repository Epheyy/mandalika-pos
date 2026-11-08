import { useState, type Dispatch } from 'react'
import { defaultHeldName, getHeldOrders, heldOrderFromState, HELD_ORDERS_FULL_MESSAGE, HELD_ORDERS_WRITE_MESSAGE, type HeldOrder } from './heldOrders'
import { planHeldRestore, type HeldRestoreEnv } from './heldRestore'
import type { CashierAction, CashierState } from './state/cashierReducer'

export interface ConfirmRequest {
  message: string
  confirmLabel: string
  tone: 'danger' | 'primary'
  run: () => void
}

interface Options {
  outletId: string
  state: CashierState
  dispatch: Dispatch<CashierAction>
  /** The catalog, promotions and clock a restore re-validates against; read at restore time. */
  getEnv: () => HeldRestoreEnv
  /** Same gates as adding to the cart: an open shift and the 12 h offline lock. Return false to stop. */
  ensureShift: () => boolean
  offlineLock: () => string | null
  askConfirm: (c: ConfirmRequest) => void
  showToast: (msg: string, tone: 'info' | 'warn') => void
}

/** D-6 Pesanan tersimpan: the held list for this outlet plus save / resume / delete, all through existing reducer actions. */
export function useHeldOrders({ outletId, state, dispatch, getEnv, ensureShift, offlineLock, askConfirm, showToast }: Options) {
  const [open, setOpen] = useState(false)
  const store = getHeldOrders(outletId)
  // The store lives outside React: re-read it after each change we make.
  const [held, setHeld] = useState<HeldOrder[]>(() => store.list())
  const refresh = (): void => setHeld(store.list())
  const hasCart = state.cart.length > 0

  const save = (name: string): void => {
    if (!hasCart) return
    const order = heldOrderFromState(state, { id: crypto.randomUUID(), name, now: Date.now() })
    const result = store.save(order)
    if (!result.ok) { showToast(result.reason === 'full' ? HELD_ORDERS_FULL_MESSAGE : HELD_ORDERS_WRITE_MESSAGE, 'warn'); return }
    dispatch({ type: 'CART_CLEAR' })
    refresh()
    setOpen(false)
    showToast(`Pesanan "${name}" tersimpan di tablet ini`, 'info')
  }

  const restore = (order: HeldOrder): void => {
    const plan = planHeldRestore(order, getEnv())
    for (const action of plan.actions) dispatch(action)
    // Items that could not come back (a size the catalog no longer sells) keep the held order, so nothing is lost for good.
    if (plan.lossless) store.remove(order.id)
    refresh()
    setOpen(false)
    const head = plan.lossless ? `Pesanan "${order.name}" dilanjutkan` : `Pesanan "${order.name}" dilanjutkan; salinannya tetap tersimpan`
    showToast(plan.notes.length > 0 ? `${head}.\n${plan.notes.join('\n')}` : head, plan.lossless && plan.notes.length === 0 ? 'info' : 'warn')
  }

  const resume = (order: HeldOrder): void => {
    if (!ensureShift()) return
    const locked = offlineLock()
    if (locked) { showToast(locked, 'warn'); return }
    if (!hasCart) { restore(order); return }
    askConfirm({ message: 'Ganti keranjang saat ini? Isinya tidak tersimpan kecuali kamu simpan dulu.', confirmLabel: 'Ganti', tone: 'primary', run: () => restore(order) })
  }

  const remove = (order: HeldOrder): void => {
    askConfirm({
      message: `Hapus pesanan tersimpan "${order.name}"? Isinya hilang dari tablet ini.`, confirmLabel: 'Hapus', tone: 'danger',
      run: () => { store.remove(order.id); refresh() },
    })
  }

  const suggestedName = defaultHeldName(state.selectedCustomer?.name, new Date())
  return { open, setOpen, held, hasCart, suggestedName, save, resume, remove }
}
