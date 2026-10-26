import type { components } from '@mandalika/api'
import { StatusBadge } from '../components/ui'
import { REFUND_DONE, refundAvailability, type RefundAvailabilityInput } from './refundView'

type Order = components['schemas']['Order']

interface RefundActionProps extends RefundAvailabilityInput {
  order: Order
  onRefund: (order: Order) => void
}

/** "Refund Transaksi Ini" for a completed order, or a muted line saying why it is not offered. */
export function RefundAction({ order, onRefund, ...gate }: RefundActionProps) {
  const a = refundAvailability({ order, ...gate })
  if (a.kind === 'hidden') return null
  if (a.kind === 'blocked') {
    return <StatusBadge tone={a.reason === REFUND_DONE ? 'neutral' : 'warn'} size="md" label={a.reason} className="mt-2 w-full justify-center" />
  }
  return (
    <button type="button"
      onClick={() => onRefund(order)}
      className="mt-2 w-full py-2 border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors"
    >
      Refund Transaksi Ini
    </button>
  )
}
