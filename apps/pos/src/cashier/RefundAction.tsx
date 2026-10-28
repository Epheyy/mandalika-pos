import type { components } from '@mandalika/api'
import { StatusBadge } from '../components/ui'
import { REFUND_DONE, REFUND_USE_HISTORY, partialGateFor, refundAvailability, refundOrderKeys, type RefundAvailabilityInput } from './refundView'
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
  const a = refundAvailability({ order, partial, ...gate })
  if (a.kind === 'hidden') return null
  // Riwayat is the way forward for this receipt, so "continue in Riwayat" is not a block here.
  const route = viaHistory && (a.kind === 'allowed' || (a.kind === 'blocked' && a.reason === REFUND_USE_HISTORY))
  if (route) {
    if (!viaHistory.online) return <StatusBadge tone="warn" size="md" label={viaHistory.offlineMessage} className="mt-2 w-full justify-center" />
    return (
      <button type="button" onClick={viaHistory.onOpen}
        className="mt-2 w-full py-2 border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors">
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
        className="mt-2 w-full py-2 border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors"
      >
        Refund Transaksi Ini
      </button>
    </>
  )
}
