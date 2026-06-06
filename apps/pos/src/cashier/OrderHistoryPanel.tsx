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

type Order = components['schemas']['Order']
type OrderListResponse = components['schemas']['OrderListResponse']

interface OrderHistoryPanelProps {
  isOpen: boolean
  onClose: () => void
  onRefund: (order: Order) => void
  /** Reprint this order's sales receipt with the REPRINT marker. */
  onReprint: (order: Order) => void
  /** A printer is paired — gates the reprint button. */
  canReprint: boolean
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS',
}
const STATUS_LABELS: Record<string, string> = {
  completed: 'Selesai', refunded: 'Refund', cancelled: 'Batal',
}
const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  refunded: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
}
const PAGE_SIZE = 20

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function OrderHistoryPanel({ isOpen, onClose, onRefund, onReprint, canReprint }: OrderHistoryPanelProps) {
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true when the rows shown came from the offline cache, not a live fetch.
  const [isStale, setIsStale] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    const term = search.trim()
    const cacheKey = `orders:${from}:${to}:${page}:${term}`
    try {
      const params: Record<string, string> = {
        from, to, page: String(page), limit: String(PAGE_SIZE),
      }
      if (term) params.q = term
      const qs = new URLSearchParams(params).toString()
      const r = await api.request<OrderListResponse>('GET', `/api/v1/orders?${qs}`)
      const data = r.data ?? []
      const t = r.meta?.total ?? 0
      setOrders(data)
      setTotal(t)
      setIsStale(false)
      cacheWrite(cacheKey, { orders: data, total: t }, 'orders:last')
    } catch (e: unknown) {
      // Offline / transient: fall back to the last data seen while online so
      // the cashier still sees their history instead of "Failed to fetch".
      const cached = cacheRead<{ orders: Order[]; total: number }>(cacheKey, 'orders:last')
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="font-bold text-gray-900">Riwayat Transaksi</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            title="Tutup"
          >
            ✕
          </button>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap gap-2 items-end flex-shrink-0">
          <div>
            <label className="block text-[10px] text-gray-500 font-semibold mb-1">Dari</label>
            <input
              type="date" value={from} max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-500 font-semibold mb-1">Sampai</label>
            <input
              type="date" value={to} min={from} max={today()}
              onChange={(e) => setTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-[10px] text-gray-500 font-semibold mb-1">Cari</label>
            <input
              type="text" value={search} placeholder="No. order / nama / telepon"
              onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <button
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
                  <button
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
                        {o.items.map((it) => (
                          <div
                            key={`${it.productId}-${it.variantSize}`}
                            className="flex justify-between text-xs text-gray-700"
                          >
                            <span>{it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{it.quantity}</span>
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
                            o.discountBreakdown.map((d, i) => (
                              <div key={i} className="flex justify-between text-red-600">
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
                      {o.refundReason && (
                        <p className="text-[11px] text-red-600 mt-2">
                          Refund: {o.refundReason}
                        </p>
                      )}
                      <button
                        onClick={() => onReprint(o)}
                        disabled={!canReprint}
                        title={canReprint ? undefined : 'Pasangkan printer untuk cetak ulang'}
                        className="mt-3 w-full py-2 border border-indigo-200 text-indigo-700 rounded-lg text-sm font-semibold hover:bg-indigo-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                      >
                        🖨 Cetak Ulang
                      </button>
                      {o.status === 'completed' && (
                        <button
                          onClick={() => onRefund(o)}
                          className="mt-2 w-full py-2 border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors"
                        >
                          Refund Transaksi Ini
                        </button>
                      )}
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
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || isLoading}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              ‹ Sebelumnya
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || isLoading}
              className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-semibold text-gray-700 disabled:opacity-40 hover:bg-gray-50"
            >
              Berikutnya ›
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
