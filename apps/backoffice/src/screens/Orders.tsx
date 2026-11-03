import { useEffect, useState } from 'react'
import { fetchAllPages, type AppSettings, type Order } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { ShoppingBag, Search, ChevronDown, ChevronUp, Download } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { BRAND } from '../lib/brand'
import { paymentFilterOptions } from '../lib/paymentOptions'
import { isSplitOrder, methodLabel, orderMethodText, orderPaymentCsv, paymentLineRows, tenderWarningTitle } from '../lib/splitPayment'
import { exportToXLSX, buildExportName } from '../lib/csvUtils'
import { useListState, type ListSchema } from '../lib/router/useListState'
import { Button } from '../ui/Button'
import { Input, Select, fieldClass } from '../ui/Field'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { Pagination } from '../ui/Pagination'
import { canViewSummary, lastDaysRange, orderFilterParams, paymentFilterHint, transaksiFilters, transaksiHeader } from './reports/orderQuery'
import { useOrderReport } from './reports/useOrderReport'
import { useUrlSearchText } from './reports/useUrlSearchText'
import { PAGING_SCHEMA, PAGE_SIZES, dayOf, dayToQuery, enumOf, pageOf, isAnswerFor, pageSizeOf, pageToClamp, paymentOf, withCurrent } from './reports/reportFilters'
import { refundedByLine } from './refundDisplay'
import { orderIconClasses, orderStatusLabel, orderStatusTone } from '../lib/orderStatus'
import { OrderRefundSection } from './orders/OrderRefundSection'
import { AdminRefundForm } from './orders/AdminRefundForm'
import { quoteWarningTitle, receiptTotalLine } from './quoteDisplay'

/** Payment lines of an order: one row per line with its reference and change; shown for split orders only. */
function PaymentLines({ order, methods }: { order: Order; methods: AppSettings['paymentMethods'] | undefined }) {
  const rows = paymentLineRows(order, methods)
  // One line of a single-method order says nothing the total and "Kembalian" do not.
  if (rows.length === 0 || (rows.length === 1 && !isSplitOrder(order))) return null
  return (
    <div className="pt-1" data-testid="payment-lines">
      <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-1">Pembayaran</p>
      {rows.map((r) => (
        <div key={r.key} className="flex justify-between text-sm text-gray-600">
          <span>
            {r.label}
            {r.reference && <span className="text-gray-400"> · ref {r.reference}</span>}
            {r.change > 0 && <span className="text-green-600"> · kembalian {BRAND.currency.format(r.change)}</span>}
          </span>
          <span className="font-bold text-gray-900">{BRAND.currency.format(r.amount)}</span>
        </div>
      ))}
    </div>
  )
}

const badgeTone = orderStatusTone
const label = orderStatusLabel

const TRANSAKSI_STATUSES = ['completed', 'partially_refunded', 'refunded', 'cancelled'] as const

interface OrdersListState {
  q: string
  status: string
  bayar: string
  dari: string
  sampai: string
  semua: boolean
  hal: number
  per: number
  [key: string]: string | number | boolean
}

// dari/sampai default to '' = the last 30 days, resolved when read (a module constant would go stale past midnight).
const ORDERS_SCHEMA: ListSchema<OrdersListState> = {
  q: { key: 'q', default: '' },
  status: { key: 'status', default: '' },
  bayar: { key: 'bayar', default: '' },
  dari: { key: 'dari', default: '' },
  sampai: { key: 'sampai', default: '' },
  semua: { key: 'semua', default: false },
  hal: PAGING_SCHEMA.hal,
  per: PAGING_SCHEMA.per,
}

/** The transactions list/table/search/refund UI — no page header. */
export function OrdersPanel() {
  const { user } = useAuth()
  const { outletId, outlets: ctxOutlets } = useOutlet()
  // Every filter, the date window and the page live in the URL (#/laporan/transaksi?status=refunded&hal=2).
  const [state, setState] = useListState(ORDERS_SCHEMA)
  const fStatus = enumOf<string>(state.status, TRANSAKSI_STATUSES, '')
  const fPay = paymentOf(state.bayar)
  // Default window: last 30 days; "Semua tanggal" lifts the date bounds (search then spans all dates).
  // A cleared date input stays cleared (unbounded) rather than snapping back to the default.
  // Once per mount: rolling over at midnight would change the query under an open refund form.
  const [defaultRange] = useState(() => lastDaysRange(30))
  const range = { dateFrom: dayOf(state.dari, defaultRange.dateFrom), dateTo: dayOf(state.sampai, defaultRange.dateTo) }
  const allDates = state.semua
  const page = pageOf(state.hal)
  const pageSize = pageSizeOf(state.per)
  // Typing replaces the entry (one per keystroke would bury Back). The live text feeds Export, the URL value the list.
  const [query, setQuery] = useUrlSearchText(state.q, (q) => setState({ q, hal: 1 }, { replace: true }))
  const debouncedQuery = state.q
  const [expanded, setExpanded] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const filters = transaksiFilters(range, allDates, { status: fStatus, payment: fPay, q: debouncedQuery })
  const showSummary = canViewSummary(user?.role === 'admin', user?.permissions ?? [])
  const { summary: sq, list: q } = useOrderReport(filters, page, pageSize, outletId, showSummary)
  const orders = q.data?.data ?? []
  const total = q.data?.meta?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // A page past the end (the last row refunded away, a stale link) moves to the last page instead of showing an empty list.
  useEffect(() => {
    if (q.loading || q.error || !q.data || !isAnswerFor(q.data.meta, page, pageSize)) return
    const target = pageToClamp(page, total, pageSize)
    if (target !== null) setState({ hal: target }, { replace: true })
  }, [q.loading, q.error, q.data, page, total, pageSize, setState])
  const settingsQ = usePolledQuery<AppSettings>(() => api.getAppSettings(), [], 60000)
  const payMethods = settingsQ.data?.paymentMethods
  const payOptions = withCurrent(paymentFilterOptions(payMethods, orders), fPay)

  const canRefund = user?.role === 'admin'
  const reloadAfterRefund = async () => {
    await Promise.all([q.refetch(), sq.refetch()])
  }

  // Detailed export for analysts: one row per order with the discount source
  // (promotion name / code / manual) and structured discount fields. Pages the whole
  // filtered set on click.
  const handleExport = async () => {
    setExportBusy(true)
    setExportError(null)
    try {
      // The live search text, not the 300 ms debounced one, so Export matches what was typed.
      const params = orderFilterParams(transaksiFilters(range, allDates, { status: fStatus, payment: fPay, q: query }))
      const all = await fetchAllPages((p, limit) => api.listOrders({ ...params, page: p, limit }))
      const rows = all.map((o) => ({
        'No. Order': o.orderNumber,
        Tanggal: format(parseISO(o.createdAt), 'yyyy-MM-dd HH:mm'),
        Status: label(o.status),
        Pembayaran: orderPaymentCsv(o, payMethods),
        Kasir: o.cashierName,
        Pelanggan: o.customerName ?? '',
        'Jumlah Item': o.items.reduce((s, it) => s + it.quantity, 0),
        Subtotal: o.subtotal,
        Diskon: o.discountAmount,
        'Sumber Diskon': o.discountLabel ?? o.discountCode ?? '',
        'Tipe Diskon': o.discountType ?? '',
        'Nilai Diskon': o.discountValue ?? '',
        'Rincian Diskon': (o.discountBreakdown ?? [])
          .map((d) => `${d.label}: ${d.amount}`)
          .join('; '),
        Pajak: o.taxAmount,
        Total: o.total,
      }))
      const scope = outletId ? (ctxOutlets.find((o) => o.id === outletId)?.name ?? null) : 'semua-outlet'
      const name = buildExportName('transaksi', [scope, fStatus || undefined, fPay || undefined, query.trim() || undefined])
      exportToXLSX(rows, name)
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Gagal mengekspor data lengkap.')
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {(q.error || sq.error) && <p role="alert" className="text-sm text-red-600">Gagal memuat data. Data sebelumnya mungkin ditampilkan. {q.error || sq.error}</p>}
      {exportError && <p role="alert" className="text-sm text-red-600">{exportError}</p>}
      <p className="text-sm text-gray-500">
        {transaksiHeader(q.data ? total : undefined, showSummary ? sq.data?.totalSales : undefined, (n) => BRAND.currency.format(n))}
        {debouncedQuery.trim() !== '' && !allDates && ' · pencarian mencakup semua tanggal'}
      </p>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
          <input
            type="text"
            aria-label="Cari order / kasir / pelanggan"
            placeholder="Cari order / kasir / pelanggan..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${fieldClass} pl-9`}
          />
        </div>
        <Input
          type="date"
          aria-label="Dari tanggal"
          value={range.dateFrom}
          disabled={allDates}
          onChange={(e) => setState({ dari: dayToQuery(e.target.value), hal: 1 }, { replace: true })}
          className="w-auto"
        />
        <Input
          type="date"
          aria-label="Sampai tanggal"
          value={range.dateTo}
          disabled={allDates}
          onChange={(e) => setState({ sampai: dayToQuery(e.target.value), hal: 1 }, { replace: true })}
          className="w-auto"
        />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={allDates} onChange={(e) => setState({ semua: e.target.checked, hal: 1 })} />
          Semua tanggal
        </label>
        <Select value={fStatus} onChange={(e) => setState({ status: e.target.value, hal: 1 })} className="w-auto" aria-label="Filter status">
          <option value="">Semua Status</option>
          <option value="completed">Selesai</option>
          <option value="partially_refunded">Sebagian refund</option>
          <option value="refunded">Refund</option>
          <option value="cancelled">Dibatalkan</option>
        </Select>
        <Select value={fPay} onChange={(e) => setState({ bayar: e.target.value, hal: 1 })} className="w-auto" aria-label="Filter pembayaran">
          <option value="">Semua Pembayaran</option>
          {payOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
        <Button
          variant="secondary"
          onClick={() => void handleExport()}
          disabled={exportBusy || q.loading || !!q.error || total === 0}
          icon={<Download className="w-4 h-4" />}
        >
          Unduh Excel
        </Button>
      </div>
      {fPay.trim() !== '' && (
        <p className="text-xs text-gray-400">{paymentFilterHint(fPay, methodLabel(fPay, payMethods))}</p>
      )}

      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : orders.length === 0 ? (
          <EmptyState icon={<ShoppingBag />} title="Tidak ada transaksi" />
        ) : (
          <div className="divide-y divide-gray-50">
            {orders.map((o) => (
              <div key={o.id}>
                <div
                  className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setExpanded(expanded === o.id ? null : o.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setExpanded(expanded === o.id ? null : o.id)
                    }
                  }}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${orderIconClasses(o.status).tile}`}>
                    <ShoppingBag className={`w-4 h-4 ${orderIconClasses(o.status).glyph}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {o.items.length} item · <span className="capitalize">{orderMethodText(o)}</span>
                      {o.customerName && <> · {o.customerName}</>} · {o.cashierName} ·{' '}
                      {format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: id })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {o.discountWarning && (
                      <span
                        title={o.discountWarningReason ?? undefined}
                        className="px-2 py-0.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700"
                      >
                        ⚠ Diskon
                      </span>
                    )}
                    {o.stockWarning && (
                      <span
                        title="Ada baris yang melebihi stok atau varian tidak ditemukan saat dijual (lihat Laporan → Stok Minus)"
                        className="px-2 py-0.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700"
                      >
                        ⚠ Stok
                      </span>
                    )}
                    {o.tenderWarning && (
                      <span
                        title={tenderWarningTitle(o.tenderWarningReason)}
                        className="px-2 py-0.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700"
                      >
                        ⚠ Bayar
                      </span>
                    )}
                    {o.quoteWarning && (
                      <span
                        title={quoteWarningTitle(o, BRAND.currency.format)}
                        className="px-2 py-0.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700"
                      >
                        ⚠ Struk
                      </span>
                    )}
                    <Badge tone={badgeTone(o.status)}>{label(o.status)}</Badge>
                    <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                    {expanded === o.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </div>
                </div>
                {expanded === o.id && (
                  <div className="px-5 pb-5 bg-gray-50 border-t border-gray-100">
                    <div className="pt-4 space-y-4">
                      <div>
                        <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Item</p>
                        <div className="space-y-1.5">
                          {o.items.map((it) => (
                            <div key={`${it.productId}|${it.variantSize}`} className="flex justify-between text-sm">
                              <span className="text-gray-600">{it.productName}{variantLabel(it.variantSize) ? ` ${variantLabel(it.variantSize)}` : ''} ×{it.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-gray-200 pt-3 space-y-1">
                        <div className="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span>{BRAND.currency.format(o.subtotal)}</span></div>
                        {o.discountAmount > 0 && (
                          o.discountBreakdown && o.discountBreakdown.length > 0 ? (
                            o.discountBreakdown.map((d) => (
                              <div key={`${d.label}|${d.kind ?? ''}`} className="flex justify-between text-sm text-green-600">
                                <span>Diskon · {d.label}{d.kind === 'percentage' && d.value ? ` (${d.value}%)` : ''}</span>
                                <span>-{BRAND.currency.format(d.amount)}</span>
                              </div>
                            ))
                          ) : (
                            <div className="flex justify-between text-sm text-green-600">
                              <span>Diskon{o.discountLabel ? ` · ${o.discountLabel}` : o.discountCode ? ` · ${o.discountCode}` : ''}</span>
                              <span>-{BRAND.currency.format(o.discountAmount)}</span>
                            </div>
                          )
                        )}
                        <div className="flex justify-between text-sm text-gray-500"><span>Pajak</span><span>{BRAND.currency.format(o.taxAmount)}</span></div>
                        <div className="flex justify-between font-black text-gray-900"><span>Total</span><span>{BRAND.currency.format(o.total)}</span></div>
                        {receiptTotalLine(o, BRAND.currency.format) && (
                          <div className="flex justify-between text-sm text-amber-700"><span>Total di struk</span><span>{receiptTotalLine(o, BRAND.currency.format)}</span></div>
                        )}
                        <PaymentLines order={o} methods={payMethods} />
                        {o.change > 0 && (
                          <div className="flex justify-between text-sm text-green-600 font-bold"><span>Kembalian</span><span>{BRAND.currency.format(o.change)}</span></div>
                        )}
                      </div>
                      {o.notes && (
                        <div className="bg-amber-50 rounded-xl p-3">
                          <p className="text-xs font-black text-amber-700 mb-1">Catatan</p>
                          <p className="text-sm text-amber-800">{o.notes}</p>
                        </div>
                      )}
                      {(o.refunds ?? []).length === 0 && o.status === 'refunded' && o.refundReason && (
                        <div className="bg-red-50 rounded-xl p-3">
                          <p className="text-xs font-black text-red-600 mb-1">Alasan Refund</p>
                          <p className="text-sm text-red-700">{o.refundReason}</p>
                          {o.refundedAt && (
                            <p className="text-xs text-red-400 mt-1">
                              {format(parseISO(o.refundedAt), 'dd MMM yyyy HH:mm', { locale: id })}
                              {refundedByLine(o) ? ` · ${refundedByLine(o)}` : ''}
                            </p>
                          )}
                          {!o.refundedAt && refundedByLine(o) && (
                            <p className="text-xs text-red-400 mt-1">{refundedByLine(o)}</p>
                          )}
                        </div>
                      )}
                      <OrderRefundSection order={o} methods={payMethods} />
                      {canRefund && <AdminRefundForm order={o} methods={payMethods} onDone={reloadAfterRefund} />}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {total > 0 && (
          <div className="px-5 py-3 border-t border-gray-100">
            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onChange={(p) => setState({ hal: p })}
              pageSize={pageSize}
              onPageSizeChange={(n) => setState({ per: n, hal: 1 })}
              pageSizes={[...PAGE_SIZES]}
            />
          </div>
        )}
      </Card>
    </div>
  )
}
