import type { Order, OrderRefund } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { BRAND } from '../../lib/brand'
import { refundedByLine } from '../refundDisplay'
import { refundFlagLabel, refundScopeLabel, remainingQty, remainingRefundable } from './refundSelection'

const money = (n: number) => BRAND.currency.format(n)

function lineName(order: Order, r: OrderRefund['items'][number]): string {
  const it = order.items.find((i) => i.id === r.orderItemId || (r.lineNo != null && i.lineNo === r.lineNo))
  if (!it) return `Baris ${r.lineNo ?? '?'}`
  const v = variantLabel(it.variantSize)
  return `${it.productName}${v ? ` ${v}` : ''}`
}

function RefundCard({ order, r }: { order: Order; r: OrderRefund }) {
  const flag = refundFlagLabel(r.amountWarning)
  const claimDiffers = r.claimedAmount != null && r.claimedAmount !== r.amount
  return (
    <div className="bg-white border border-red-100 rounded-xl p-3 space-y-1">
      <div className="flex justify-between gap-2">
        <p className="text-sm font-bold text-gray-900">
          Refund ke-{r.seq} <span className="font-normal text-gray-500">· {refundScopeLabel(r.scope)}</span>
        </p>
        <p className="text-sm font-black text-red-600">{money(r.amount)}</p>
      </div>
      <p className="text-xs text-gray-400">
        {format(parseISO(r.refundedAt), 'dd MMM yyyy HH:mm', { locale: id })}
        {r.refundedByName ? ` · ${refundedByLine({ refundedByName: r.refundedByName })}` : ''}
        {r.paymentMethod ? ` · ${r.paymentMethod}` : ''}
      </p>
      {r.items.length > 0 && (
        <ul className="text-xs text-gray-600 space-y-0.5">
          {r.items.map((li) => (
            <li key={li.orderItemId} className="flex justify-between">
              <span>{lineName(order, li)} ×{li.quantity}</span>
              <span>{money(li.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {(claimDiffers || flag) && (
        <p className="text-xs text-amber-700">
          {claimDiffers && <>Diklaim tablet {money(r.claimedAmount as number)} </>}
          {flag && <span className="px-1.5 py-0.5 rounded bg-amber-50 font-bold">{flag}</span>}
        </p>
      )}
      <p className="text-xs text-gray-700">Alasan: {r.reason}</p>
    </div>
  )
}

/** Refund history + per-line refunded/remaining + remaining refundable amount for an order detail. */
export function OrderRefundSection({ order }: { order: Order }) {
  const refunds = order.refunds ?? []
  const rest = remainingRefundable(order)
  const touched = order.status === 'partially_refunded' || order.status === 'refunded' || refunds.length > 0
  if (!touched) return null
  const lines = order.items.filter((i) => (i.refundedQty ?? 0) > 0)
  return (
    <div className="space-y-2">
      {refunds.map((r) => <RefundCard key={r.id} order={order} r={r} />)}
      {lines.length > 0 && (
        <div className="bg-amber-50 rounded-xl p-3 space-y-0.5">
          <p className="text-xs font-black text-amber-700">Status per item</p>
          {lines.map((it) => (
            <p key={it.id ?? `${it.productId}|${it.variantSize}`} className="text-xs text-amber-800">
              {it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''}: direfund {it.refundedQty}, sisa {remainingQty(it)}
            </p>
          ))}
        </div>
      )}
      {order.refundedAmount !== undefined && (
        <p className="text-xs font-bold text-amber-800">Total direfund {money(order.refundedAmount)}</p>
      )}
      {rest !== null && <p className="text-sm font-bold text-gray-900">Sisa bisa direfund {money(rest)}</p>}
    </div>
  )
}
