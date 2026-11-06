import type { components } from '@mandalika/api'
import { StatusBadge } from '../components/ui'
import { REFUND_DONE, partialGateFor, refundAvailability, refundOrderKeys, type RefundAvailabilityInput } from './refundView'
import type { RefundCache } from './refundSelection'

type Order = components['schemas']['Order']

interface RefundActionProps extends Omit<RefundAvailabilityInput, 'partial'> {
  order: Order
  onRefund: (order: Order) => void
  /** C4b: units and money this tablet saw acknowledged for an order named by any of these ids. */
  refundCache?: (ids: readonly string[]) => RefundCache
  /** A local receipt that cannot be refunded from here (no line data, already synced): online it opens Riwayat on this
   *  order, offline it shows `offlineMessage` and no button. */
  viaHistory?: { online: boolean; onOpen: () => void; offlineMessage: string }
}

/** "Refund Transaksi Ini" for a refundable order, or a muted line saying why it is not offered. A part-refunded
 *  order keeps the button and adds the "Sebagian direfund · sisa Rp X" chip. */
export function RefundAction({ order, onRefund, refundCache, viaHistory, ...gate }: RefundActionProps) {
  const partial = partialGateFor(order, refundCache?.(refundOrderKeys({ order, ...gate })))
  // A receipt that must be refunded from Riwayat is judged on the plain gates (permission, shift, queue, already done):
  // earlier partial refunds make no difference to it, they are why it goes to Riwayat.
  const a = refundAvailability(viaHistory ? { order, ...gate } : { order, partial, ...gate })
  if (a.kind === 'hidden') return null
  if (viaHistory && a.kind === 'allowed') {
    if (!viaHistory.online) return <StatusBadge tone="warn" size="md" label={viaHistory.offlineMessage} className="mt-2 w-full justify-center" />
    return (
      <button type="button" onClick={viaHistory.onOpen}
        className="mt-2 w-full min-h-12 border border-danger text-danger rounded-control text-sm font-semibold press active:bg-danger-bg">
        Refund lewat Riwayat
      </button>
    )
  }
  if (a.kind === 'blocked') {
    return <StatusBadge tone={a.reason === REFUND_DONE ? 'neutral' : 'warn'} size="md" label={a.reason} className="mt-2 w-full justify-center" />
  }
  return (
    <>
      {a.note && <StatusBadge tone="warn" size="md" label={a.note} className="mt-2 w-full justify-center" />}
      <button type="button"
        onClick={() => onRefund(order)}
        className="mt-2 w-full min-h-12 border border-danger text-danger rounded-control text-sm font-semibold press active:bg-danger-bg"
      >
        Refund Transaksi Ini
      </button>
    </>
  )
}
