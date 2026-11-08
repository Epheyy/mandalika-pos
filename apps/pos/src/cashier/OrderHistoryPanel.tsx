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
import { methodCellLabel, refundSummaries, tenderLineText, visibleTenders, type PayoutMethodCfg } from './refundView'
import type { RefundCache } from './refundSelection'
import { LatestLoad, PAGE_SIZE, businessToday, defaultHistoryDay, historyWindowFor, orderHistoryQuery, withPinnedOrder } from './orderHistoryQuery'
import { Sheet } from '../components/ui/Sheet'
import { formatHistoryStamp } from './historyStamp'
import { zoneParts } from './promoValidate'
import { Button } from '../components/ui/Button'
import { StatusBadge } from '../components/ui/StatusBadge'
import type { Tone } from '../components/ui/tone'
import { IconPrinter } from '../components/ui/icons'
import { orderAdjustmentRow } from './receiptRows'

type Order = components['schemas']['Order']
type OrderListResponse = components['schemas']['OrderListResponse']

/** Open on one sale: its day window, its number in the search box, its row expanded. The parent keys the panel by it. */
export interface HistoryFocus {
  orderId: string
  orderNumber: string
  capturedAt: string
  /** Distinguishes two openings on the same order, so the panel starts fresh each time. */
  nonce: number
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
  /** The configured payment methods, to name the lines of a split sale. Optional. */
  paymentMethods?: readonly PayoutMethodCfg[]
  /** Outlet timezone from the sync bundle (A28); absent = Asia/Jakarta. Decides "today". */
  timezone?: string | null
  /** ISO open time of the shown shift; its business day is the default day (A28). */
  shiftOpenedAt?: string | null
}
const ONE_DAY_MS = 86_400_000

/** The day before `day` (YYYY-MM-DD). */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - ONE_DAY_MS).toISOString().slice(0, 10)
}

type DateMode = 'today' | 'yesterday' | 'custom'

/** Which quick segment the range is: one single day equal to today or yesterday; anything else is "Pilih tanggal". */
export function dateModeOf(from: string, to: string, today: string): DateMode {
  if (from !== to) return 'custom'
  if (from === today) return 'today'
  if (from === dayBefore(today)) return 'yesterday'
  return 'custom'
}

/** "Kemarin 16:42" / "Hari ini 09:05" on the outlet clock; older sales keep the full date. Display only. */
export function historyRowStamp(iso: string, today: string, timezone?: string | null): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return formatHistoryStamp(iso)
  const day = businessToday(at, timezone)
  const word = day === today ? 'Hari ini' : day === dayBefore(today) ? 'Kemarin' : null
  if (!word) return formatHistoryStamp(iso)
  const { hhmm } = zoneParts(at, timezone)
  return `${word} ${hhmm}`
}

const STATUS_LABELS: Record<string, string> = {
  completed: 'Selesai', partially_refunded: 'Sebagian refund', refunded: 'Refund', cancelled: 'Batal',
}
const STATUS_TONES: Record<string, Tone> = {
  completed: 'ok', partially_refunded: 'warn', refunded: 'danger', cancelled: 'neutral',
}


export function OrderHistoryPanel({ isOpen, focus, onClose, onRefund, onReprint, canReprint, canRefund, hasOpenShift, shiftUnsynced, queuedRefundOrderIds, syncedRefundOrderIds, queuedSaleUuids, serverIdToSaleUuid, refundCache, paymentMethods, timezone, shiftOpenedAt }: OrderHistoryPanelProps) {
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
  // "Pilih tanggal" shows the two date boxes even while the range still equals today or yesterday.
  const [customOpen, setCustomOpen] = useState(false)
  const [search, setSearch] = useState(focus?.orderNumber ?? '')
  const [page, setPage] = useState(1)
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true when the rows shown came from the offline cache, not a live fetch.
  const [isStale, setIsStale] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(focus?.orderId ?? null)
  // The order the cashier came for, fetched by id: the day listing is filtered by the shift's business day and may miss it.
  const [pinned, setPinned] = useState<Order | null>(null)
  // Day, page and search each start a load; a slow answer for the old filters must not overwrite the new one.
  const [loadGate] = useState(() => new LatestLoad())

  const load = useCallback(async () => {
    const ticket = loadGate.begin()
    setIsLoading(true)
    setError(null)
    const term = search.trim()
    const { qs, cacheKey } = orderHistoryQuery(from, to, page, term)
    try {
      const r = await api.request<OrderListResponse>('GET', `/api/v1/orders?${qs}`)
      if (!loadGate.isCurrent(ticket)) return
      const data = r.data ?? []
      const t = r.meta?.total ?? 0
      setOrders(data)
      setTotal(t)
      setIsStale(false)
      if (focus && !data.some((o) => o.id === focus.orderId)) {
        try {
          const one = await api.getOrder(focus.orderId)
          if (loadGate.isCurrent(ticket)) setPinned(one)
        } catch {
          if (loadGate.isCurrent(ticket)) setPinned(null)
        }
      }
      // A search is never cached (A30); only the plain day listing is.
      if (cacheKey) cacheWrite(cacheKey, { orders: data, total: t }, 'orders:last')
    } catch (e: unknown) {
      if (!loadGate.isCurrent(ticket)) return
      // Offline / transient: fall back to the last data seen while online so
      // the cashier still sees their history instead of "Failed to fetch".
      // A focused search is never cached, and the last unfiltered day listing would show unrelated sales under it: no fallback.
      const cached = focus && term
        ? null
        : cacheKey
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
      if (loadGate.isCurrent(ticket)) setIsLoading(false)
    }
  }, [from, to, page, search, focus, loadGate])

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

  const today = businessToday(new Date(), timezone)
  const mode: DateMode = customOpen ? 'custom' : dateModeOf(from, to, today)
  const pickDay = (day: string) => { setPickedDay(true); setCustomOpen(false); setFrom(day); setTo(day) }
  const filtered = withPinnedOrder(orders, focus ? pinned : null)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Sheet open variant="center" maxWidth="max-w-2xl" panelClassName="max-h-[90vh] flex flex-col" title="Riwayat Transaksi" header onClose={onClose}>

        {/* Filters: quick day segments like the mock; "Pilih tanggal" reveals the range boxes. */}
        <div className="px-5 py-3 border-b border-paper-2 space-y-2 flex-shrink-0">
          <div role="group" aria-label="Tanggal hari shift" title="Menurut hari bisnis shift, bukan jam transaksi" className="grid grid-cols-3 gap-1 p-1 rounded-control bg-paper-1">
            {([['today', 'Hari ini'], ['yesterday', 'Kemarin'], ['custom', 'Pilih tanggal']] as const).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={mode === key}
                onClick={() => (key === 'today' ? pickDay(today) : key === 'yesterday' ? pickDay(dayBefore(today)) : setCustomOpen(true))}
                className={`min-h-11 rounded-control text-sm font-semibold press ${mode === key ? 'bg-white text-brand-strong shadow-sm' : 'text-ink-700'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            {mode === 'custom' && (
              <>
                <div>
                  <label htmlFor="history-from" className="block text-xs text-ink-700 font-semibold mb-1">Dari (hari shift)</label>
                  <input
                    id="history-from"
                    type="date" value={from} max={to}
                    onChange={(e) => { setPickedDay(true); setCustomOpen(true); setFrom(e.target.value) }}
                    className="min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong"
                  />
                </div>
                <div>
                  <label htmlFor="history-to" className="block text-xs text-ink-700 font-semibold mb-1">Sampai (hari shift)</label>
                  <input
                    id="history-to"
                    type="date" value={to} min={from} max={today}
                    onChange={(e) => { setPickedDay(true); setCustomOpen(true); setTo(e.target.value) }}
                    className="min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong"
                  />
                </div>
              </>
            )}
            <div className="flex-1 min-w-[140px]">
              <label htmlFor="history-search" className="block text-xs text-ink-700 font-semibold mb-1">Cari</label>
              <input
                id="history-search"
                type="text" value={search} placeholder="No. order / nama / telepon"
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-h-11 surface-card rounded-control px-3 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-strong"
              />
            </div>
            <Button onClick={() => void load()} disabled={isLoading}>
              {isLoading ? 'Memuat…' : 'Muat'}
            </Button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="text-sm text-danger py-4 text-center">{error}</p>}
          {isStale && !error && (
            <p className="text-xs font-semibold text-warn-strong bg-warn-bg rounded-control px-3 py-2 mb-2 text-center">
              {OFFLINE_NOTICE}
            </p>
          )}
          {isLoading && filtered.length === 0 && <ListSkeleton rows={5} />}
          {!error && !isLoading && filtered.length === 0 && (
            <p className="text-sm text-ink-500 py-8 text-center">Tidak ada transaksi</p>
          )}
          <div className="space-y-2">
            {filtered.map((o) => {
              const expanded = expandedId === o.id
              return (
                <div key={o.id} className={`surface-card rounded-control overflow-hidden ${expanded ? 'ring-2 ring-brand-strong' : ''}`}>
                  <button type="button"
                    onClick={() => setExpandedId(expanded ? null : o.id)}
                    aria-expanded={expanded}
                    className="w-full min-h-16 flex items-center gap-3 px-4 py-3 text-left active:bg-paper-1"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm text-ink-900 truncate">
                        #{o.orderNumber} · {o.customerName || 'Tanpa pelanggan'}
                      </p>
                      <p className="text-xs text-ink-500 truncate">
                        {historyRowStamp(o.createdAt, today, timezone)} · {methodCellLabel(o, paymentMethods)}
                      </p>
                    </div>
                    <StatusBadge tone={STATUS_TONES[o.status] ?? 'neutral'} label={STATUS_LABELS[o.status] ?? o.status} />
                    <span className="font-bold text-sm text-ink-900 flex-shrink-0 tnum">
                      {formatRupiah(o.total)}
                    </span>
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                      className={`flex-shrink-0 text-ink-500 transition-transform ${expanded ? 'rotate-90' : ''}`}><path d="M1 1l6 6-6 6" /></svg>
                  </button>

                  {expanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-paper-2 surface-group">
                      {visibleTenders(o).length > 0 && (
                        <div className="pt-2 space-y-0.5" data-testid="order-tenders">
                          {visibleTenders(o).map((t) => <p key={t.seq} className="text-xs text-ink-700">{tenderLineText(t, paymentMethods)}</p>)}
                        </div>
                      )}
                      <div className="space-y-1 py-2">
                        {o.items.map((it, n) => (
                          <div
                            key={`${it.lineNo ?? n}-${it.productId}-${it.variantSize}`}
                            className="flex justify-between text-xs text-ink-700"
                          >
                            <span>
                              {it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{it.quantity}
                              {(it.refundedQty ?? 0) > 0 ? <span className="text-danger"> · {it.refundedQty} direfund</span> : null}
                            </span>
                            <span>{formatRupiah(it.subtotal)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-dashed border-paper-2 pt-2 space-y-0.5 text-xs">
                        <div className="flex justify-between text-ink-500">
                          <span>Subtotal</span><span>{formatRupiah(o.subtotal)}</span>
                        </div>
                        {o.discountAmount > 0 && (
                          o.discountBreakdown && o.discountBreakdown.length > 0 ? (
                            o.discountBreakdown.map((d) => (
                              <div key={`${d.label}-${d.kind}`} className="flex justify-between text-danger">
                                <span>
                                  Diskon · {d.label}
                                  {d.kind === 'percentage' && d.value ? ` (${d.value}%)` : ''}
                                </span>
                                <span>−{formatRupiah(d.amount)}</span>
                              </div>
                            ))
                          ) : (
                            <div className="flex justify-between text-danger">
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
                          <div className="flex justify-between text-ink-500">
                            <span>
                              Surcharge
                              {o.surchargeType === 'percentage' && o.surchargeValue ? ` (${o.surchargeValue}%)` : ''}
                            </span>
                            <span>+{formatRupiah(o.surchargeAmount ?? 0)}</span>
                          </div>
                        )}
                        {o.taxAmount > 0 && (
                          <div className="flex justify-between text-ink-500">
                            <span>PPN</span><span>{formatRupiah(o.taxAmount)}</span>
                          </div>
                        )}
                        {(() => {
                          const adj = orderAdjustmentRow(o)
                          return adj && (
                            <div className="flex justify-between text-ink-500" data-testid="history-adjustment">
                              <span>{adj.label}</span><span>{adj.amount < 0 ? '−' : '+'}{formatRupiah(Math.abs(adj.amount))}</span>
                            </div>
                          )
                        })()}
                        <div className="flex justify-between font-bold text-ink-900 pt-0.5">
                          <span>Total</span><span>{formatRupiah(o.total)}</span>
                        </div>
                      </div>
                      {(o.refundedAmount ?? 0) > 0 && (
                        <p className="text-xs text-danger mt-2" data-testid="history-refunded-amount">
                          Direfund {formatRupiah(o.refundedAmount ?? 0)}{o.status === 'partially_refunded' ? ` · sisa ${formatRupiah(Math.max(0, o.total - (o.refundedAmount ?? 0)))}` : ''}
                        </p>
                      )}
                      {refundSummaries(o).map((r) => (
                        <div key={r.seq} className="text-xs text-ink-700 mt-1" data-testid="history-refund">
                          <p className="font-semibold">Refund ke-{r.seq} · {formatRupiah(r.amount)} · {r.reason}</p>
                          {r.lines.map((l, i) => <p key={i} className="pl-3">− {l.name} ×{l.quantity} ({formatRupiah(l.amount)})</p>)}
                        </div>
                      ))}
                      {o.refundReason && (
                        <p className="text-xs text-danger mt-2">
                          Refund: {o.refundReason}
                        </p>
                      )}
                      <Button variant="secondary" fullWidth className="mt-3"
                        onClick={() => onReprint(o)}
                        disabled={!canReprint}
                        title={canReprint ? undefined : 'Pasangkan printer untuk cetak ulang'}
                        leading={<IconPrinter size={14} />}
                      >
                        Cetak Ulang
                      </Button>
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
        <div className="flex items-center justify-between px-5 py-3 border-t border-paper-2 flex-shrink-0">
          <span className="text-xs text-ink-500">
            {total} transaksi · hal {page}/{totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || isLoading}>
              ‹ Sebelumnya
            </Button>
            <Button variant="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || isLoading}>
              Berikutnya ›
            </Button>
          </div>
        </div>
    </Sheet>
  )
}
