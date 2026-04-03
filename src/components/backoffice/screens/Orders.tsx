import { useState, useEffect } from 'react'
import type { AppUser, Order, Product } from '../../../types'
import { OrderStatus } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, query, orderBy, doc, updateDoc, getDoc } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { format, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { ShoppingBag, Search, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'

interface Props { appUser: AppUser }

export default function Orders({ appUser }: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterPayment, setFilterPayment] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [refundingId, setRefundingId] = useState<string | null>(null)
  const [refundNote, setRefundNote] = useState('')
  const [isRefunding, setIsRefunding] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() } as Order)))
      setIsLoading(false)
    })
    return () => unsub()
  }, [])

  const filtered = orders.filter(o => {
    const matchSearch =
      o.orderNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
      o.cashierName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (o.customerName || '').toLowerCase().includes(searchQuery.toLowerCase())
    const matchStatus = !filterStatus || o.status === filterStatus
    const matchPayment = !filterPayment || o.paymentMethod === filterPayment
    return matchSearch && matchStatus && matchPayment
  })

  const totalRevenue = filtered
    .filter(o => o.status === OrderStatus.COMPLETED)
    .reduce((s, o) => s + o.total, 0)

  const handleRefund = async (orderId: string) => {
    if (!refundNote.trim()) { alert('Alasan refund wajib diisi'); return }
    setIsRefunding(true)
    try {
      const order = orders.find(o => o.id === orderId)
      if (!order) return

      // 1. Update order status
      await updateDoc(doc(db, 'orders', orderId), {
        status: OrderStatus.REFUNDED,
        refundReason: refundNote.trim(),
        refundedAt: new Date().toISOString(),
      })

      // 2. Restore stock for each item
      for (const item of order.items) {
        const productRef = doc(db, 'products', item.productId)
        const productSnap = await getDoc(productRef)
        if (productSnap.exists()) {
          const productData = productSnap.data() as Product
          const updatedVariants = productData.variants.map(v =>
            v.size === item.variantSize
              ? { ...v, stock: v.stock + item.quantity }
              : v
          )
          await updateDoc(productRef, { variants: updatedVariants })
        }
      }

      setRefundingId(null)
      setRefundNote('')
      setExpandedId(null)
    } catch {
      alert('Gagal memproses refund.')
    } finally {
      setIsRefunding(false)
    }
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-50 text-green-700'
      case 'refunded': return 'bg-red-50 text-red-600'
      case 'cancelled': return 'bg-gray-100 text-gray-500'
      default: return 'bg-gray-100 text-gray-500'
    }
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case 'completed': return 'Selesai'
      case 'refunded': return 'Refund'
      case 'cancelled': return 'Dibatalkan'
      default: return status
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Transaksi</h2>
          <p className="text-sm text-gray-400">{filtered.length} transaksi · Total: {BRAND.currency.format(totalRevenue)}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Cari order / kasir / pelanggan..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">Semua Status</option>
          <option value="completed">Selesai</option>
          <option value="refunded">Refund</option>
          <option value="cancelled">Dibatalkan</option>
        </select>
        <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">Semua Pembayaran</option>
          <option value="cash">Tunai</option>
          <option value="card">Kartu</option>
          <option value="qris">QRIS</option>
          <option value="transfer">Transfer</option>
        </select>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-300">Memuat transaksi...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
            <ShoppingBag className="w-12 h-12" />
            <p className="font-bold">Tidak ada transaksi</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(order => (
              <div key={order.id}>
                <div
                  className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 cursor-pointer transition-all"
                  onClick={() => {
                    setExpandedId(expandedId === order.id ? null : order.id!)
                    setRefundingId(null)
                    setRefundNote('')
                  }}
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${order.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                    <ShoppingBag className={`w-4 h-4 ${order.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {order.items.length} item · <span className="capitalize">{order.paymentMethod}</span>
                      {order.customerName && <> · {order.customerName}</>}
                      {' · '}{order.cashierName} · {format(parseISO(order.createdAt), 'dd MMM yyyy HH:mm', { locale: id })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${statusBadge(order.status)}`}>{statusLabel(order.status)}</span>
                    <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                    {expandedId === order.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </div>
                </div>

                {expandedId === order.id && (
                  <div className="px-5 pb-5 bg-gray-50 border-t border-gray-100">
                    <div className="pt-4 space-y-4">

                      {/* Items */}
                      <div>
                        <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Item</p>
                        <div className="space-y-1.5">
                          {order.items.map((item, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(item.subtotal)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Totals */}
                      <div className="border-t border-gray-200 pt-3 space-y-1">
                        <div className="flex justify-between text-sm text-gray-500">
                          <span>Subtotal</span><span>{BRAND.currency.format(order.subtotal)}</span>
                        </div>
                        {order.discountAmount > 0 && (
                          <div className="flex justify-between text-sm text-green-600">
                            <span>Diskon {order.discountType === 'percentage' ? `${order.discountValue}%` : ''}</span>
                            <span>-{BRAND.currency.format(order.discountAmount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-sm text-gray-500">
                          <span>Pajak</span><span>{BRAND.currency.format(order.taxAmount)}</span>
                        </div>
                        <div className="flex justify-between font-black text-gray-900">
                          <span>Total</span><span>{BRAND.currency.format(order.total)}</span>
                        </div>
                        {order.paymentMethod === 'cash' && order.change > 0 && (
                          <div className="flex justify-between text-sm text-green-600 font-bold">
                            <span>Kembalian</span><span>{BRAND.currency.format(order.change)}</span>
                          </div>
                        )}
                      </div>

                      {/* Notes */}
                      {order.notes && (
                        <div className="bg-yellow-50 rounded-xl p-3">
                          <p className="text-xs font-black text-yellow-700 mb-1">Catatan</p>
                          <p className="text-sm text-yellow-800">{order.notes}</p>
                        </div>
                      )}

                      {/* Refund reason (for refunded orders) */}
                      {order.status === 'refunded' && order.refundReason && (
                        <div className="bg-red-50 rounded-xl p-3">
                          <p className="text-xs font-black text-red-600 mb-1">Alasan Refund</p>
                          <p className="text-sm text-red-700">{order.refundReason}</p>
                          {order.refundedAt && (
                            <p className="text-xs text-red-400 mt-1">
                              {format(parseISO(order.refundedAt), 'dd MMM yyyy HH:mm', { locale: id })}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Refund button — admin only, completed orders */}
                      {appUser.role === 'admin' && order.status === OrderStatus.COMPLETED && (
                        <div>
                          {refundingId === order.id ? (
                            <div className="space-y-2">
                              <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Alasan Refund *</p>
                              <textarea
                                value={refundNote}
                                onChange={e => setRefundNote(e.target.value)}
                                placeholder="Tuliskan alasan refund secara jelas..."
                                rows={3}
                                className="w-full px-3 py-2 bg-white border-2 border-red-200 rounded-xl text-sm resize-none focus:outline-none focus:border-red-400"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={() => { setRefundingId(null); setRefundNote('') }}
                                  className="flex-1 py-2 border border-gray-200 text-gray-600 text-sm font-bold rounded-xl hover:bg-gray-100"
                                >
                                  Batal
                                </button>
                                <button
                                  onClick={() => handleRefund(order.id!)}
                                  disabled={isRefunding}
                                  className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-bold rounded-xl transition-all"
                                >
                                  {isRefunding ? 'Memproses...' : 'Konfirmasi Refund'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              onClick={e => { e.stopPropagation(); setRefundingId(order.id!); setRefundNote('') }}
                              className="flex items-center gap-2 px-3 py-2 text-red-500 hover:bg-red-50 text-sm font-bold rounded-xl transition-all"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              Proses Refund
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