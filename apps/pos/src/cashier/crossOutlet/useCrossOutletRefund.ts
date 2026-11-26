import { useMemo, useRef, useState } from 'react'
import type { Api, CrossOutletOrder, CrossOutletRefundResult } from '@mandalika/api'
import type { components } from '@mandalika/api'
import type { SubmitGate } from '../../lib/durableSubmit'
import type { RefundPayload } from '../refundView'
import { createAttemptStore, type AttemptStore } from './crossOutletAttempt'
import {
  newRefundUuid, resendPendingCrossOutletRefund, submitCrossOutletRefund,
  type CrossOutletDeps, type CrossOutletOutcome, type CrossOutletSubmit, type SentRefund,
} from './crossOutletRefundFlow'

type Order = components['schemas']['Order']

/** A sale made at another outlet than the one this tablet is signed in to (the refund must go online, never to the outbox). */
export function isCrossOutletOrder(order: Pick<Order, 'outletId'> | null | undefined, activeOutletId: string | null | undefined): boolean {
  return !!order?.outletId && !!activeOutletId && order.outletId !== activeOutletId
}

/** Where a confirmed refund goes: a sale of this outlet to the outbox, a sale of another outlet straight to the server. */
export function routeRefund(order: Pick<Order, 'outletId'> | null | undefined, activeOutletId: string | null | undefined): 'cross' | 'outbox' {
  return isCrossOutletOrder(order, activeOutletId) ? 'cross' : 'outbox'
}

/** The unanswered attempt, as the dialog needs it. */
export interface PendingRef { orderId: string; orderNumber: string }

export interface Options {
  api: Pick<Api, 'refundCrossOutlet' | 'crossOutletLookup'>
  isOnline: boolean
  deviceId: string
  /** The refund single-flight gate shared with same-outlet refunds. */
  gate: SubmitGate
  /** The server stored the refund (201 or 200 replay): close the dialog, refresh the shift, print. `sent` names the sale
   *  and reason that were actually sent, which is not necessarily the one open in the dialog. */
  onApplied: (result: CrossOutletRefundResult, message: string, replayed: boolean, sent: SentRefund) => void
  /** "Cek transaksi" found the sale again: show it (with its current refunded quantities) in the dialog. */
  onOrderRefreshed: (order: Order) => void
}

/** What the controller writes to; the hook backs these with React state. */
export interface CrossOutletUi {
  setOriginName: (v: string | null) => void
  setError: (v: string | null) => void
  setBusy: (v: boolean) => void
  setPending: (v: PendingRef | null) => void
}

const pendingRef = (store: AttemptStore): PendingRef | null => {
  const a = store.read()
  return a ? { orderId: a.orderId, orderNumber: a.orderNumber } : null
}

/** The logic of the online-only cross-outlet refund (A18), free of React so it can be tested directly.
 *  The pending attempt lives in storage, not here: resetting the UI never drops an unsure outcome. */
export function createCrossOutletController(getOpts: () => Options, store: AttemptStore, ui: CrossOutletUi) {
  const deps = (): CrossOutletDeps => {
    const o = getOpts()
    return { api: o.api, store, newUuid: newRefundUuid, isOnline: o.isOnline }
  }

  const settle = (out: CrossOutletOutcome): void => {
    if (out.kind === 'applied') {
      ui.setError(null)
      ui.setPending(null)
      getOpts().onApplied(out.result, out.message, out.replayed, out.sent)
      return
    }
    ui.setError(out.message)
    ui.setPending(pendingRef(store))
  }

  const run = async (action: () => Promise<CrossOutletOutcome | null>): Promise<void> => {
    const gate = getOpts().gate
    if (gate.isBusy()) return // a second tap while one is in flight: the first one owns the busy state
    ui.setError(null)
    ui.setBusy(true)
    const res = await gate.run(action)
    ui.setBusy(false)
    if (res.status === 'failed') { ui.setError('Refund belum terkirim. Coba lagi.'); ui.setPending(pendingRef(store)); return }
    if (res.status === 'saved' && res.value) settle(res.value)
  }

  return {
    begin: (co: CrossOutletOrder): Order => { ui.setOriginName(co.outletName); ui.setError(null); ui.setPending(pendingRef(store)); return co.order },
    /** UI state only: a stored unsure attempt stays in storage and is offered again when its sale is opened. */
    reset: (): void => { ui.setOriginName(null); ui.setError(null); ui.setPending(pendingRef(store)) },
    submit: (s: { order: Order; payload: RefundPayload; shiftId: string }): Promise<void> => {
      const sub: CrossOutletSubmit = {
        orderId: s.order.id, orderNumber: s.order.orderNumber, shiftId: s.shiftId, deviceId: getOpts().deviceId, payload: s.payload,
      }
      return run(() => submitCrossOutletRefund(deps(), sub))
    },
    /** "Kirim ulang refund sebelumnya": the stored body, unchanged. */
    resend: (): Promise<void> => run(() => resendPendingCrossOutletRefund(deps())),
    /** "Cek transaksi": looks up the sale of the PENDING attempt (not the one displayed) by its order number, and opens it. */
    check: async (displayed: Order): Promise<void> => {
      const o = getOpts()
      if (!o.isOnline) { ui.setError('Butuh internet'); return }
      const p = store.read()
      const number = p?.orderNumber || displayed.orderNumber
      const id = p?.orderId ?? displayed.id
      try {
        const rows = await o.api.crossOutletLookup({ orderNumber: number })
        const hit = rows.find((r) => r.order.id === id)
        if (hit) { ui.setOriginName(hit.outletName); ui.setError(null); o.onOrderRefreshed(hit.order) }
        else ui.setError('Transaksi tidak ditemukan. Jangan bayar sebelum yakin refund tersimpan.')
      } catch {
        ui.setError('Tidak bisa memeriksa sekarang. Coba lagi.')
      }
    },
  }
}

/** State and actions of the online-only cross-outlet refund (A18). */
export function useCrossOutletRefund(o: Options) {
  const store = useMemo(() => createAttemptStore(), [])
  const [originName, setOriginName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // An unanswered attempt exists (survives a restart: it is read from storage).
  const [pending, setPending] = useState<PendingRef | null>(() => pendingRef(store))
  const opts = useRef(o)
  opts.current = o
  const ctl = useMemo(
    () => createCrossOutletController(() => opts.current, store, { setOriginName, setError, setBusy, setPending }),
    [store],
  )
  return { originName, error, busy, pending, ...ctl }
}
