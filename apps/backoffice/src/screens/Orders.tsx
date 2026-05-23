import { useState } from 'react'
import type { Order } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { ShoppingBag, Search, ChevronDown, ChevronUp, RotateCcw, Download } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { BRAND } from '../lib/brand'
import { exportToXLSX } from '../lib/csvUtils'

export default function Orders() {
  const { user } = useAuth()
  const { outletId } = useOutlet()
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

  const badge = (st: string) =>
    st === 'completed'
      ? 'bg-green-50 text-green-700'
      : st === 'refunded'
        ? 'bg-red-50 text-red-600'
        : 'bg-gray-100 text-gray-500'
  const label = (st: string) =>
    st === 'completed' ? 'Selesai' : st === 'refunded' ? 'Refund' : st === 'cancelled' ? 'Dibatalkan' : st

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
      Pajak: o.taxAmount,
      Total: o.total,
    }))
    exportToXLSX(rows, 'transaksi')
  }

  return (
    <div className="p-6 space-y-5">
      <div>
        <h2 className="text-xl font-black text-gray-900">Transaksi</h2>
        <p className="text-sm text-gray-400">
          {filtered.length} transaksi · Total: {BRAND.currency.format(revenue)}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Cari order / kasir / pelanggan..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none">
          <option value="">Semua Status</option>
          <option value="completed">Selesai</option>
          <option value="refunded">Refund</option>
          <option value="cancelled">Dibatalkan</option>
        </select>
        <select value={fPay} onChange={(e) => setFPay(e.target.value)} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none">
          <option value="">Semua Pembayaran</option>
          <option value="cash">Tunai</option>
          <option value="card">Kartu</option>
          <option value="qris">QRIS</option>
          <option value="transfer">Transfer</option>
        </select>
        <button
          onClick={handleExport}
          disabled={filtered.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors"
        >
          <Download className="w-4 h-4" /> Export
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {q.loading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
            <ShoppingBag className="w-12 h-12" />
            <p className="font-bold">Tidak ada transaksi</p>
          </div>
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
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                    <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
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
                    <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${badge(o.status)}`}>{label(o.status)}</span>
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
                              <span className="text-gray-600">{it.productName} {it.variantSize} ×{it.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-gray-200 pt-3 space-y-1">
                        <div className="flex justify-between text-sm text-gray-500"><span>Subtotal</span><span>{BRAND.currency.format(o.subtotal)}</span></div>
                        {o.discountAmount > 0 && (
                          <div className="flex justify-between text-sm text-green-600">
                            <span>Diskon{o.discountLabel ? ` · ${o.discountLabel}` : o.discountCode ? ` · ${o.discountCode}` : ''}</span>
                            <span>-{BRAND.currency.format(o.discountAmount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-sm text-gray-500"><span>Pajak</span><span>{BRAND.currency.format(o.taxAmount)}</span></div>
                        <div className="flex justify-between font-black text-gray-900"><span>Total</span><span>{BRAND.currency.format(o.total)}</span></div>
                        {o.paymentMethod === 'cash' && o.change > 0 && (
                          <div className="flex justify-between text-sm text-green-600 font-bold"><span>Kembalian</span><span>{BRAND.currency.format(o.change)}</span></div>
                        )}
                      </div>
                      {o.notes && (
                        <div className="bg-yellow-50 rounded-xl p-3">
                          <p className="text-xs font-black text-yellow-700 mb-1">Catatan</p>
                          <p className="text-sm text-yellow-800">{o.notes}</p>
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
                              <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Alasan Refund *</p>
                              <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder="Tuliskan alasan refund secara jelas..."
                                rows={3}
                                className="w-full px-3 py-2 bg-white border-2 border-red-200 rounded-xl text-sm resize-none focus:outline-none focus:border-red-400"
                              />
                              {err && <p className="text-xs text-red-600">{err}</p>}
                              <div className="flex gap-2">
                                <button onClick={() => { setRefundingId(null); setNote(''); setErr(null) }} className="flex-1 py-2 border border-gray-200 text-gray-600 text-sm font-bold rounded-xl hover:bg-gray-100">Batal</button>
                                <button onClick={() => refund(o.id)} disabled={busy} className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-bold rounded-xl">
                                  {busy ? 'Memproses...' : 'Konfirmasi Refund'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setRefundingId(o.id); setNote(''); setErr(null) }}
                              className="flex items-center gap-2 px-3 py-2 text-red-500 hover:bg-red-50 text-sm font-bold rounded-xl"
                            >
                              <RotateCcw className="w-3.5 h-3.5" /> Proses Refund
                            </button>
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
      </div>
    </div>
  )
}
