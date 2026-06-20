import { useState } from 'react'
import type { Order } from '@mandalika/api'
import { variantLabel } from '@mandalika/types'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { ShoppingBag, Search, ChevronDown, ChevronUp, RotateCcw, Download } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { BRAND } from '../lib/brand'
import { exportToXLSX, buildExportName } from '../lib/csvUtils'
import { Button } from '../ui/Button'
import { Select, Textarea, fieldClass } from '../ui/Field'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'

const badgeTone = (st: string): 'success' | 'danger' | 'neutral' =>
  st === 'completed' ? 'success' : st === 'refunded' ? 'danger' : 'neutral'
const label = (st: string) =>
  st === 'completed' ? 'Selesai' : st === 'refunded' ? 'Refund' : st === 'cancelled' ? 'Dibatalkan' : st

/** The transactions list/table/search/refund UI — no page header. */
export function OrdersPanel() {
  const { user } = useAuth()
  const { outletId, outlets: ctxOutlets } = useOutlet()
  const [query, setQuery] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fPay, setFPay] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [refundingId, setRefundingId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const q = usePolledQuery<Order[]>(
    () => api.listOrders({ limit: 500 }).then((r) => r.data),
    [outletId],
  )
  const orders = q.data ?? []

  const filtered = orders.filter((o) => {
    const s = query.toLowerCase()
    const mS =
      o.orderNumber.toLowerCase().includes(s) ||
      o.cashierName.toLowerCase().includes(s) ||
      (o.customerName || '').toLowerCase().includes(s)
    return mS && (!fStatus || o.status === fStatus) && (!fPay || o.paymentMethod === fPay)
  })
  const revenue = filtered
    .filter((o) => o.status === 'completed')
    .reduce((s, o) => s + o.total, 0)

  const refund = async (orderId: string) => {
    if (!note.trim()) {
      setErr('Alasan refund wajib diisi')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await api.refundOrder(orderId, note.trim())
      setRefundingId(null)
      setNote('')
      setExpanded(null)
      await q.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal memproses refund.')
    } finally {
      setBusy(false)
    }
  }

  // Detailed export for analysts — one row per order with the discount source
  // (promotion name / code / manual) and structured discount fields.
  const handleExport = () => {
    const rows = filtered.map((o) => ({
      'No. Order': o.orderNumber,
      Tanggal: format(parseISO(o.createdAt), 'yyyy-MM-dd HH:mm'),
      Status: label(o.status),
      Pembayaran: o.paymentMethod,
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
    const name = buildExportName('transaksi', [scope, fStatus || undefined, fPay || undefined, query || undefined])
    exportToXLSX(rows, name)
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">{filtered.length} transaksi · Total: {BRAND.currency.format(revenue)}</p>

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
        <Select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="w-auto" aria-label="Filter status">
          <option value="">Semua Status</option>
          <option value="completed">Selesai</option>
          <option value="refunded">Refund</option>
          <option value="cancelled">Dibatalkan</option>
        </Select>
        <Select value={fPay} onChange={(e) => setFPay(e.target.value)} className="w-auto" aria-label="Filter pembayaran">
          <option value="">Semua Pembayaran</option>
          <option value="cash">Tunai</option>
          <option value="card">Kartu</option>
          <option value="qris">QRIS</option>
          <option value="transfer">Transfer</option>
        </Select>
        <Button
          variant="secondary"
          onClick={handleExport}
          disabled={filtered.length === 0}
          icon={<Download className="w-4 h-4" />}
        >
          Export
        </Button>
      </div>

      <Card className="overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<ShoppingBag />} title="Tidak ada transaksi" />
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((o) => (
              <div key={o.id}>
                <div
                  className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer"
                  onClick={() => {
                    setExpanded(expanded === o.id ? null : o.id)
                    setRefundingId(null)
                    setNote('')
                  }}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-gold-50'}`}>
                    <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-gold-600'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {o.items.length} item · <span className="capitalize">{o.paymentMethod}</span>
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
                          {o.items.map((it, i) => (
                            <div key={i} className="flex justify-between text-sm">
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
                            o.discountBreakdown.map((d, i) => (
                              <div key={i} className="flex justify-between text-sm text-green-600">
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
                        {o.paymentMethod === 'cash' && o.change > 0 && (
                          <div className="flex justify-between text-sm text-green-600 font-bold"><span>Kembalian</span><span>{BRAND.currency.format(o.change)}</span></div>
                        )}
                      </div>
                      {o.notes && (
                        <div className="bg-amber-50 rounded-xl p-3">
                          <p className="text-xs font-black text-amber-700 mb-1">Catatan</p>
                          <p className="text-sm text-amber-800">{o.notes}</p>
                        </div>
                      )}
                      {o.status === 'refunded' && o.refundReason && (
                        <div className="bg-red-50 rounded-xl p-3">
                          <p className="text-xs font-black text-red-600 mb-1">Alasan Refund</p>
                          <p className="text-sm text-red-700">{o.refundReason}</p>
                          {o.refundedAt && (
                            <p className="text-xs text-red-400 mt-1">
                              {format(parseISO(o.refundedAt), 'dd MMM yyyy HH:mm', { locale: id })}
                            </p>
                          )}
                        </div>
                      )}
                      {user?.role === 'admin' && o.status === 'completed' && (
                        <div>
                          {refundingId === o.id ? (
                            <div className="space-y-2">
                              <Textarea
                                label="Alasan Refund *"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Tuliskan alasan refund secara jelas..."
                                rows={3}
                                error={err ?? undefined}
                              />
                              <div className="flex gap-2">
                                <Button
                                  variant="secondary"
                                  className="flex-1"
                                  onClick={() => { setRefundingId(null); setNote(''); setErr(null) }}
                                >
                                  Batal
                                </Button>
                                <Button
                                  variant="danger"
                                  className="flex-1"
                                  loading={busy}
                                  onClick={() => refund(o.id)}
                                >
                                  {busy ? 'Memproses...' : 'Konfirmasi Refund'}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); setRefundingId(o.id); setNote(''); setErr(null) }}
                              icon={<RotateCcw className="w-3.5 h-3.5" />}
                            >
                              Proses Refund
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
