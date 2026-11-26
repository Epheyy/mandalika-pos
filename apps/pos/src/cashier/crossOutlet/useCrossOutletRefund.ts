import { useMemo, useState } from 'react'
import type { Api, CrossOutletOrder, CrossOutletRefundResult } from '@mandalika/api'
import type { components } from '@mandalika/api'
import type { SubmitGate } from '../../lib/durableSubmit'
import type { RefundPayload } from '../refundView'
import { createAttemptStore } from './crossOutletAttempt'
import {
  newRefundUuid, resendPendingCrossOutletRefund, submitCrossOutletRefund,
  type CrossOutletDeps, type CrossOutletOutcome, type CrossOutletSubmit,
} from './crossOutletRefundFlow'

type Order = components['schemas']['Order']

/** A sale made at another outlet than the one this tablet is signed in to (the refund must go online, never to the outbox). */
export function isCrossOutletOrder(order: Pick<Order, 'outletId'> | null | undefined, activeOutletId: string | null | undefined): boolean {
  return !!order?.outletId && !!activeOutletId && order.outletId !== activeOutletId
}

interface Options {
  api: Pick<Api, 'refundCrossOutlet' | 'crossOutletLookup'>
  isOnline: boolean
  deviceId: string
  /** The refund single-flight gate shared with same-outlet refunds. */
  gate: SubmitGate
  /** The server stored the refund (201 or 200 replay): close the dialog, refresh the shift, print. */
  onApplied: (result: CrossOutletRefundResult, message: string, replayed: boolean) => void
  /** "Cek transaksi" found the sale again: show its current refunded quantities in the dialog. */
  onOrderRefreshed: (order: Order) => void
}

/** State and actions of the online-only cross-outlet refund (A18). The pending attempt lives in storage, not here. */
export function useCrossOutletRefund(o: Options) {
  const store = useMemo(() => createAttemptStore(), [])
  const [originName, setOriginName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // An unanswered attempt exists (survives a restart: it is read from storage).
  const [pending, setPending] = useState(() => store.read() !== null)

  const deps = (): CrossOutletDeps => ({ api: o.api, store, newUuid: newRefundUuid, isOnline: o.isOnline })

  const settle = (out: CrossOutletOutcome): void => {
    if (out.kind === 'applied') {
      setError(null)
      setPending(false)
      o.onApplied(out.result, out.message, out.replayed)
      return
    }
    setError(out.message)
    setPending(store.read() !== null)
  }

  const run = async (action: () => Promise<CrossOutletOutcome | null>): Promise<void> => {
    setError(null)
    setBusy(true)
    const res = await o.gate.run(action)
    setBusy(false)
    if (res.status === 'failed') { setError('Refund belum terkirim. Coba lagi.'); return }
    if (res.status === 'saved' && res.value) settle(res.value)
  }

  return {
    originName, error, busy, pending,
    /** Opens a looked-up sale for refund; returns its order for the dialog. */
    begin: (co: CrossOutletOrder): Order => { setOriginName(co.outletName); setError(null); return co.order },
    reset: (): void => { setOriginName(null); setError(null) },
    submit: (s: { order: Order; payload: RefundPayload; shiftId: string }): Promise<void> => {
      const sub: CrossOutletSubmit = {
        orderId: s.order.id, orderNumber: s.order.orderNumber, shiftId: s.shiftId, deviceId: o.deviceId, payload: s.payload,
      }
      return run(() => submitCrossOutletRefund(deps(), sub))
    },
    /** "Kirim ulang refund sebelumnya": the stored body, unchanged. */
    resend: (): Promise<void> => run(() => resendPendingCrossOutletRefund(deps())),
    /** "Cek transaksi": looks the sale up again by its order number so the refunded quantities show. */
    check: async (order: Order): Promise<void> => {
      if (!o.isOnline) { setError('Butuh internet'); return }
      try {
        const rows = await o.api.crossOutletLookup({ orderNumber: order.orderNumber })
        const hit = rows.find((r) => r.order.id === order.id)
        if (hit) o.onOrderRefreshed(hit.order)
        else setError('Transaksi tidak ditemukan. Jangan bayar sebelum yakin refund tersimpan.')
      } catch {
        setError('Tidak bisa memeriksa sekarang. Coba lagi.')
      }
    },
  }
}
