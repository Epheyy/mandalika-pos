/**
 * Order history — date-range search over GET /api/v1/orders (server-paginated,
 * outlet-scoped). Expand a row for line items; refund routes into RefundDialog.
 */
import { useCallback, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { formatRupiah } from './pricing'
import { cacheRead, cacheWrite, OFFLINE_NOTICE } from '../lib/offlineCache'
import { ListSkeleton } from '../components/Skeleton'
import { variantLabel } from '@mandalika/types'
import { RefundAction } from './RefundAction'
import { PAYMENT_LABELS, refundSummaries } from './refundView'
import type { RefundCache } from './refundSelection'
import { PAGE_SIZE, businessToday, defaultHistoryDay, historyWindowFor, orderHistoryQuery } from './orderHistoryQuery'
import { Sheet } from '../components/ui/Sheet'
import { IconPrinter } from '../components/ui/icons'

type Order = components['schemas']['Order']
type OrderListResponse = components['schemas']['OrderListResponse']

/** Open on one sale: its day window, its number in the search box, its row expanded. The parent keys the panel by it. */
export interface HistoryFocus {
  orderId: string
  orderNumber: string
  capturedAt: string
}

interface OrderHistoryPanelProps {
  isOpen: boolean
  /** C4b: a synced local receipt without line data is refunded from here; the panel opens on that order. */
  focus?: HistoryFocus | null
  onClose: () => void
  onRefund: (order: Order) => void
  /** Reprint this order's sales receipt with the REPRINT marker. */
  onReprint: (order: Order) => void
  /** A printer is paired — gates the reprint button. */
  canReprint: boolean
  /** The signed-in user may refund (UI gate only; the server decides). */
  canRefund: boolean
  /** A synced open shift exists: a refund pays out of that drawer. */
  hasOpenShift: boolean
  /** The shift shown has no server id yet. */
  shiftUnsynced?: boolean
  /** Orders with a refund already queued or parked on this device. */
  queuedRefundOrderIds: ReadonlySet<string>
  /** Orders whose refund already synced from this tablet (stale cached rows may still say completed). */
  syncedRefundOrderIds?: ReadonlySet<string>
  /** Sales (by uuid) with a queued or parked linked refund. */
  queuedSaleUuids?: ReadonlySet<string>
  /** Server id -> sale uuid for sales this tablet made, so a refund queued under the uuid blocks the server row too. */
  serverIdToSaleUuid?: ReadonlyMap<string, string>
  /** C4b: units and money this tablet saw acknowledged for earlier per-line refunds of an order. */
  refundCache?: (ids: readonly string[]) => RefundCache
  /** Outlet timezone from the sync bundle (A28); absent = Asia/Jakarta. Decides "today". */
  timezone?: string | null
  /** ISO open time of the shown shift; its business day is the default day (A28). */
  shiftOpenedAt?: string | null
}
const STATUS_LABELS: Record<string, string> = {
  completed: 'Selesai', partially_refunded: 'Sebagian refund', refunded: 'Refund', cancelled: 'Batal',
}
const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  partially_refunded: 'bg-amber-100 text-amber-800',
  refunded: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
}

export function OrderHistoryPanel({ isOpen, focus, onClose, onRefund, onReprint, canReprint, canRefund, hasOpenShift, shiftUnsynced, queuedRefundOrderIds, syncedRefundOrderIds, queuedSaleUuids, serverIdToSaleUuid, refundCache, timezone, shiftOpenedAt }: OrderHistoryPanelProps) {
  const [from, setFrom] = useState(() => focus ? historyWindowFor(focus.capturedAt, new Date(), timezone).from : defaultHistoryDay(new Date(), timezone, shiftOpenedAt))
  const [to, setTo] = useState(() => focus ? historyWindowFor(focus.capturedAt, new Date(), timezone).to : defaultHistoryDay(new Date(), timezone, shiftOpenedAt))
  // Once the cashier picks a day (or the panel opened on a given sale), a late-arriving timezone/shift no longer moves it.
  const [pickedDay, setPickedDay] = useState(!!focus)
  useEffect(() => {
    if (pickedDay) return
    const day = defaultHistoryDay(new Date(), timezone, shiftOpenedAt)
    setFrom(day)
    setTo(day)
  }, [pickedDay, timezone, shiftOpenedAt])
  const [search, setSearch] = useState(focus?.orderNumber ?? '')
  const [page, setPage] = useState(1)
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true when the rows shown came from the offline cache, not a live fetch.
  const [isStale, setIsStale] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(focus?.orderId ?? null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    const term = search.trim()
    const { qs, cacheKey } = orderHistoryQuery(from, to, page, term)
    try {
      const r = await api.request<OrderListResponse>('GET', `/api/v1/orders?${qs}`)
      const data = r.data ?? []
      const t = r.meta?.total ?? 0
      setOrders(data)
      setTotal(t)
      setIsStale(false)
      // A search is never cached (A30); only the plain day listing is.
      if (cacheKey) cacheWrite(cacheKey, { orders: data, total: t }, 'orders:last')
    } catch (e: unknown) {
      // Offline / transient: fall back to the last data seen while online so
      // the cashier still sees their history instead of "Failed to fetch".
      const cached = cacheKey
        ? cacheRead<{ orders: Order[]; total: number }>(cacheKey, 'orders:last')
        : cacheRead<{ orders: Order[]; total: number }>('orders:last')
      if (cached) {
        setOrders(cached.orders)
        setTotal(cached.total)
        setIsStale(true)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : 'Gagal memuat riwayat')
        setOrders([])
        setTotal(0)
        setIsStale(false)
      }
    } finally {
      setIsLoading(false)
    }
  }, [from, to, page, search])

  // Debounced so typing a phone/name doesn't fire a request per keystroke.
  useEffect(() => {
    if (!isOpen) return
    const t = setTimeout(() => void load(), 300)
    return () => clearTimeout(t)
  }, [isOpen, load])

  // Reset to page 1 whenever the date range or search term changes.
  useEffect(() => {
    setPage(1)
  }, [from, to, search])

  if (!isOpen) return null

  const filtered = orders
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Sheet open variant="center" maxWidth="max-w-2xl" panelClassName="max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="font-bold text-gray-900">Riwayat Transaksi</h3>
          <button type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="Tutup"
          >
            ✕
          </button>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap gap-2 items-end flex-shrink-0">
          <div>
            <label htmlFor="history-from" className="block text-[10px] text-gray-500 font-semibold mb-1">Dari</label>
            <input
              id="history-from"
              type="date" value={from} max={to}
              onChange={(e) => { setPickedDay(true); setFrom(e.target.value) }}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label htmlFor="history-to" className="block text-[10px] text-gray-500 font-semibold mb-1">Sampai</label>
            <input
              id="history-to"
              type="date" value={to} min={from} max={businessToday(new Date(), timezone)}
              onChange={(e) => { setPickedDay(true); setTo(e.target.value) }}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label htmlFor="history-search" className="block text-[10px] text-gray-500 font-semibold mb-1">Cari</label>
            <input
              id="history-search"
              type="text" value={search} placeholder="No. order / nama / telepon"
              onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <button type="button"
            onClick={() => void load()}
            disabled={isLoading}
            className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold disabled:opacity-40 hover:bg-indigo-700 transition-colors"
          >
            {isLoading ? 'Memuat…' : 'Muat'}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="text-sm text-red-600 py-4 text-center">{error}</p>}
          {isStale && !error && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2 text-center">
              {OFFLINE_NOTICE}
            </p>
          )}
          {isLoading && filtered.length === 0 && <ListSkeleton rows={5} />}
          {!error && !isLoading && filtered.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">Tidak ada transaksi</p>
          )}
          <div className="space-y-2">
            {filtered.map((o) => {
              const expanded = expandedId === o.id
              return (
                <div key={o.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <button type="button"
                    onClick={() => setExpandedId(expanded ? null : o.id)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-gray-50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-900">{o.orderNumber}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${STATUS_STYLES[o.status] ?? ''}`}>
                          {STATUS_LABELS[o.status] ?? o.status}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 truncate">
                        {new Date(o.createdAt).toLocaleString('id-ID', {
                          day: '2-digit', month: '2-digit', year: '2-digit',
                          hour: '2-digit', minute: '2-digit',
                        })}
                        {o.customerName ? ` · ${o.customerName}` : ''}
                        {` · ${PAYMENT_LABELS[o.paymentMethod] ?? o.paymentMethod}`}
                      </p>
                    </div>
                    <span className="font-bold text-sm text-gray-900 flex-shrink-0 ml-2">
                      {formatRupiah(o.total)}
                    </span>
                  </button>

                  {expanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-gray-100 bg-gray-50">
                      <div className="space-y-1 py-2">
                        {o.items.map((it, n) => (
                          <div
                            key={`${it.lineNo ?? n}-${it.productId}-${it.variantSize}`}
                            className="flex justify-between text-xs text-gray-700"
                          >
                            <span>
                              {it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{it.quantity}
                              {(it.refundedQty ?? 0) > 0 ? <span className="text-red-600"> · {it.refundedQty} direfund</span> : null}
                            </span>
                            <span>{formatRupiah(it.subtotal)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-dashed border-gray-200 pt-2 space-y-0.5 text-xs">
                        <div className="flex justify-between text-gray-500">
                          <span>Subtotal</span><span>{formatRupiah(o.subtotal)}</span>
                        </div>
                        {o.discountAmount > 0 && (
                          o.discountBreakdown && o.discountBreakdown.length > 0 ? (
                            o.discountBreakdown.map((d) => (
                              <div key={`${d.label}-${d.kind}`} className="flex justify-between text-red-600">
                                <span>
                                  Diskon · {d.label}
                                  {d.kind === 'percentage' && d.value ? ` (${d.value}%)` : ''}
                                </span>
                                <span>−{formatRupiah(d.amount)}</span>
                              </div>
                            ))
                          ) : (
                            <div className="flex justify-between text-red-600">
                              <span>
                                Diskon
                                {o.discountLabel
                                  ? ` · ${o.discountLabel}`
                                  : o.discountCode ? ` · ${o.discountCode}` : ''}
                                {o.discountType === 'percentage' && o.discountValue ? ` (${o.discountValue}%)` : ''}
                              </span>
                              <span>−{formatRupiah(o.discountAmount)}</span>
                            </div>
                          )
                        )}
                        {(o.surchargeAmount ?? 0) > 0 && (
                          <div className="flex justify-between text-gray-500">
                            <span>
                              Surcharge
                              {o.surchargeType === 'percentage' && o.surchargeValue ? ` (${o.surchargeValue}%)` : ''}
                            </span>
                            <span>+{formatRupiah(o.surchargeAmount ?? 0)}</span>
                          </div>
                        )}
                        {o.taxAmount > 0 && (
                          <div className="flex justify-between text-gray-500">
                            <span>PPN</span><span>{formatRupiah(o.taxAmount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between font-bold text-gray-900 pt-0.5">
                          <span>Total</span><span>{formatRupiah(o.total)}</span>
                        </div>
                      </div>
                      {(o.refundedAmount ?? 0) > 0 && (
                        <p className="text-[11px] text-red-600 mt-2" data-testid="history-refunded-amount">
                          Direfund {formatRupiah(o.refundedAmount ?? 0)}{o.status === 'partially_refunded' ? ` · sisa ${formatRupiah(Math.max(0, o.total - (o.refundedAmount ?? 0)))}` : ''}
                        </p>
                      )}
                      {refundSummaries(o).map((r) => (
                        <div key={r.seq} className="text-[11px] text-gray-600 mt-1" data-testid="history-refund">
                          <p className="font-semibold">Refund ke-{r.seq} · {formatRupiah(r.amount)} · {r.reason}</p>
                          {r.lines.map((l, i) => <p key={i} className="pl-3">− {l.name} ×{l.quantity} ({formatRupiah(l.amount)})</p>)}
                        </div>
                      ))}
                      {o.refundReason && (
                        <p className="text-[11px] text-red-600 mt-2">
                          Refund: {o.refundReason}
                        </p>
                      )}
                      <button type="button"
                        onClick={() => onReprint(o)}
                        disabled={!canReprint}
                        title={canReprint ? undefined : 'Pasangkan printer untuk cetak ulang'}
                        className="mt-3 w-full py-2 border border-indigo-200 text-indigo-700 rounded-lg text-sm font-semibold hover:bg-indigo-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                      >
                        <IconPrinter size={14} className="inline-block align-[-0.125em]" /> Cetak Ulang
                      </button>
                      <RefundAction
                        order={o}
                        canRefund={canRefund}
                        hasOpenShift={hasOpenShift}
                        shiftUnsynced={shiftUnsynced}
                        queuedOrderIds={queuedRefundOrderIds}
                        syncedRefundOrderIds={syncedRefundOrderIds}
                        queuedSaleUuids={queuedSaleUuids}
                        serverIdToSaleUuid={serverIdToSaleUuid}
                        refundCache={refundCache}
                        onRefund={onRefund}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 flex-shrink-0">
          <span className="text-xs text-gray-500">
            {total} transaksi · hal {page}/{totalPages}
          </span>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || isLoading}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              ‹ Sebelumnya
            </button>
            <button type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || isLoading}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              Berikutnya ›
            </button>
          </div>
        </div>
    </Sheet>
  )
}
