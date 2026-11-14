import { useRef, useState, type Dispatch } from 'react'
import type { components } from '@mandalika/api'
import { uuid } from '@mandalika/sync'
import type { VoidSlipData } from '@mandalika/printer'
import type { CashFlagMethod, Shift } from '@mandalika/types'
import { createSubmitGate, notSavedMessage } from '../../lib/durableSubmit'
import type { HeldRestoreEnv } from '../heldRestore'
import type { ConfirmRequest } from '../useHeldOrders'
import type { CashierAction } from '../state/cashierReducer'
import type { BatalkanInput } from './batalkanState'
import { startVoidDraftActions, voidSlipData } from './voidCheckout'
import type { VoidDraft } from './voidReplacement'
import { buildVoidPayload, originalTendersOf, voidAvailability, type LocalVoidSale, type VoidAvailabilityInput } from './voidRules'

type Order = components['schemas']['Order']
type VoidPreview = components['schemas']['VoidPreview']

/** The sale the Batalkan sheet is open on. `order` drives the sheet and the replacement cart; `sale` feeds the payload
 *  (a LocalVoidSale for a sale not synced yet). */
export interface VoidTarget {
  order: Order
  sale: Order | LocalVoidSale
  /** The server's id of the sale, when it has one (the preview is read by it). */
  serverId: string | null
  /** The `void` item's key for "Batalkan saja", minted once per opening so a retry is the same item. Also the replacement uuid. */
  uuid: string
  preview: VoidPreview | null
  previewLoading: boolean
}

interface Options {
  engine: { enqueue(type: 'void', payload: Record<string, unknown>, orderUuid: string): Promise<unknown> }
  dispatch: Dispatch<CashierAction>
  cartHasItems: boolean
  currentShift: Pick<Shift, 'id' | 'status'> | null
  isOnline: boolean
  methods: readonly CashFlagMethod[]
  /** The outlet's giveaway unit of an Order from the server (its items do not carry it); undefined when the outlet has none. */
  giveaway: { productId: string; variantSize: string } | null | undefined
  voidedBy: string
  getEnv: () => HeldRestoreEnv
  /** The fresh availability inputs, read at action time (queues change while a sheet is open). */
  getGate: () => Omit<VoidAvailabilityInput, 'order'>
  getPreview: (orderId: string) => Promise<VoidPreview>
  ensureShift: () => boolean
  offlineLock: () => string | null
  askConfirm: (c: ConfirmRequest) => void
  showToast: (msg: string, tone: 'info' | 'warn') => void
  /** Closes Riwayat and Struk di tablet ini behind the sheet. */
  closePanels: () => void
  /** Prints the DIBATALKAN slip; a failure is reported by the caller and never undoes the void. */
  printSlip: (data: VoidSlipData) => Promise<void>
}

const REPLACE_CART = 'Ganti keranjang saat ini? Isinya tidak tersimpan kecuali kamu simpan dulu.'
const ALREADY = 'Transaksi ini tidak dapat dibatalkan lagi dari tablet ini.'

/** Opens and commits the Batalkan sheet, "Batalkan & perbaiki" and "Buat pengganti" (Void phase 3). Nothing is voided
 *  until a `void` outbox item is saved; "perbaiki" and "pengganti" only open the replacement cart. */
export function useVoidFlow(o: Options) {
  const [target, setTarget] = useState<VoidTarget | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gate = useRef(createSubmitGate())
  /** A slow preview of a sheet that was closed (or replaced) must not land on the next one. */
  const ticket = useRef(0)

  const close = (): void => { ticket.current += 1; setTarget(null); setError(null) }

  const openVoid = (order: Order, sale: Order | LocalVoidSale, serverId: string | null): void => {
    if (!o.ensureShift()) return
    const locked = o.offlineLock()
    if (locked) { o.showToast(locked, 'warn'); return }
    const mine = ++ticket.current
    const wantsPreview = o.isOnline && serverId !== null
    setError(null)
    setTarget({ order, sale, serverId, uuid: uuid(), preview: null, previewLoading: wantsPreview })
    o.closePanels()
    if (!wantsPreview || serverId === null) return
    // A preview that cannot be read leaves the sheet in its offline form: the server decides at sync (and may refuse, O6).
    o.getPreview(serverId).then(
      (preview) => { if (ticket.current === mine) setTarget((t) => (t ? { ...t, preview, previewLoading: false } : t)) },
      () => { if (ticket.current === mine) setTarget((t) => (t ? { ...t, previewLoading: false } : t)) },
    )
  }

  const stillVoidable = (t: VoidTarget): boolean => voidAvailability({ order: t.sale, ...o.getGate() }).kind === 'void'

  const giveawayOf = (t: VoidTarget): { productId: string; variantSize: string } | null =>
    // A local receipt's lines already hold the giveaway unit; an Order's items never do.
    'orderUuid' in t.sale || !o.giveaway ? null : { productId: o.giveaway.productId, variantSize: o.giveaway.variantSize }

  const startCart = (draft: VoidDraft, order: Order): void => {
    const run = (): void => {
      const shiftId = o.currentShift?.id ? o.currentShift.id : null
      const started = startVoidDraftActions(order, draft, o.getEnv(), { replacementUuid: draft.replacementUuid ?? uuid(), shiftId })
      for (const a of started.actions) o.dispatch(a)
      o.dispatch({ type: 'SET_ACTIVE_TAB', tab: 'cart' })
      o.closePanels()
      setTarget(null)
      setError(null)
      if (started.notes.length > 0) o.showToast(started.notes.join('\n'), 'warn')
    }
    if (!o.cartHasItems) { run(); return }
    o.askConfirm({ message: REPLACE_CART, confirmLabel: 'Ganti', tone: 'primary', run })
  }

  const confirm = async (input: BatalkanInput): Promise<void> => {
    const t = target
    if (!t || gate.current.isBusy() || t.previewLoading) return
    const locked = o.offlineLock()
    if (locked) { setError(locked); return }
    if (t.preview && !t.preview.eligible) { setError(t.preview.refusal ?? ALREADY); return }
    if (!stillVoidable(t)) { setError(ALREADY); return }
    const choices = Object.keys(input.stockChoices).length > 0 ? input.stockChoices : undefined
    if (input.choice === 'perbaiki') {
      const sale = t.sale
      const local = 'orderUuid' in sale
      const draft: VoidDraft = {
        orderId: local ? (sale.serverOrderId ?? '') : sale.id,
        ...(local ? { saleOrderUuid: sale.orderUuid } : {}),
        orderNumber: sale.orderNumber,
        originalTotal: sale.total,
        originalTenders: originalTendersOf(sale, o.methods),
        reason: input.reason,
        note: input.note,
        stockChoices: input.stockChoices,
        shiftId: sale.shiftId ? sale.shiftId : null,
        amountsLocked: t.preview?.amountsLocked ?? false,
        kind: 'void_and_replace',
        replacementUuid: t.uuid,
        sale,
        giveaway: giveawayOf(t),
      }
      startCart(draft, t.order)
      return
    }
    setError(null)
    setIsProcessing(true)
    const payload = buildVoidPayload({
      order: t.sale, reason: input.reason, note: input.note, mode: 'none', stockChoices: choices, methods: o.methods, giveaway: giveawayOf(t),
    })
    const outcome = await gate.current.run(() => o.engine.enqueue('void', payload, t.uuid))
    if (outcome.status === 'busy') return
    setIsProcessing(false)
    if (outcome.status === 'failed') { setError(notSavedMessage('Pembatalan')); return }
    setTarget(null)
    o.showToast(`Transaksi #${t.sale.orderNumber} dibatalkan: stok dipulihkan saat terkirim`, 'info')
    // Only now that the void is saved: a print failure is a toast, never an undo.
    o.printSlip(voidSlipData({ draft: { orderNumber: t.sale.orderNumber, originalTotal: t.sale.total, reason: input.reason, note: input.note }, voidedBy: o.voidedBy, at: new Date() }))
      .catch((e: unknown) => o.showToast(e instanceof Error ? e.message : 'Gagal mencetak slip pembatalan', 'warn'))
  }

  /** "Buat pengganti" on an older voided sale: its cart, amounts locked, sent as an `order` with replacesOrderId. */
  const openReplacement = (order: Order): void => {
    if (!o.ensureShift()) return
    const locked = o.offlineLock()
    if (locked) { o.showToast(locked, 'warn'); return }
    const draft: VoidDraft = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      originalTotal: order.total,
      originalTenders: originalTendersOf(order, o.methods),
      reason: order.void?.reasonCode ?? 'lainnya',
      note: '',
      stockChoices: {},
      shiftId: order.shiftId ? order.shiftId : null,
      amountsLocked: true,
      kind: 'create_replacement',
      replacementUuid: uuid(),
      sale: order,
    }
    startCart(draft, order)
  }

  return { target, isProcessing, error, openVoid, openReplacement, confirm, close }
}
