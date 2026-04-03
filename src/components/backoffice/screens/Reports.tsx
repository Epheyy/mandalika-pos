import { useState, useEffect } from 'react'
import type { AppUser, Order, Shift, Outlet } from '../../../types'
import { OrderStatus } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { exportToCSV } from '../../../lib/csvUtils'
import { format, parseISO, isWithinInterval, startOfDay, endOfDay } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Download, ShoppingBag, TrendingUp, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'

interface Props { appUser?: AppUser }

export default function Reports({ appUser: _appUser }: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [activeTab, setActiveTab] = useState<'transactions' | 'shifts'>('transactions')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Filters
  const [dateFrom, setDateFrom] = useState(new Date().toISOString().slice(0, 10))
  const [dateTo, setDateTo] = useState(new Date().toISOString().slice(0, 10))
  const [filterOutlet, setFilterOutlet] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterPayment, setFilterPayment] = useState('')

  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc')), s => setOrders(s.docs.map(d => ({ id: d.id, ...d.data() } as Order))))
    const u2 = onSnapshot(query(collection(db, 'shifts'), orderBy('openedAt', 'desc')), s => setShifts(s.docs.map(d => ({ id: d.id, ...d.data() } as Shift))))
    const u3 = onSnapshot(collection(db, 'outlets'), s => setOutlets(s.docs.map(d => ({ id: d.id, ...d.data() } as Outlet))))
    return () => { u1(); u2(); u3() }
  }, [])

  const inDateRange = (dateStr: string) => {
    try {
      const d = parseISO(dateStr)
      return isWithinInterval(d, { start: startOfDay(parseISO(dateFrom)), end: endOfDay(parseISO(dateTo)) })
    } catch { return false }
  }

  const filteredOrders = orders.filter(o => {
    return inDateRange(o.createdAt) &&
      (!filterOutlet || o.outletId === filterOutlet) &&
      (!filterStatus || o.status === filterStatus) &&
      (!filterPayment || o.paymentMethod === filterPayment)
  })

  const filteredShifts = shifts.filter(s => {
    return inDateRange(s.openedAt) && (!filterOutlet || s.outletId === filterOutlet)
  })

  // Order stats
  const completedOrders = filteredOrders.filter(o => o.status === OrderStatus.COMPLETED)
  const refundedOrders = filteredOrders.filter(o => o.status === OrderStatus.REFUNDED)
  const totalRevenue = completedOrders.reduce((s, o) => s + o.total, 0)
  const totalRefunds = refundedOrders.reduce((s, o) => s + o.total, 0)

  const paymentBreakdown = completedOrders.reduce((acc, o) => {
    acc[o.paymentMethod] = (acc[o.paymentMethod] || 0) + o.total
    return acc
  }, {} as Record<string, number>)

  // Export transactions
  const exportTransactions = () => {
    const rows = filteredOrders.map(o => ({
      'No. Order': o.orderNumber,
      'Tanggal': format(parseISO(o.createdAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }),
      'Kasir': o.cashierName,
      'Salesman': o.salesmanName || '-',
      'Pelanggan': o.customerName || '-',
      'Item': o.items.map(i => `${i.productName} ${i.variantSize} x${i.quantity}`).join('; '),
      'Subtotal': o.subtotal,
      'Diskon': o.discountAmount,
      'Pajak': o.taxAmount,
      'Total': o.total,
      'Metode Bayar': o.paymentMethod,
      'Status': o.status,
      'Catatan': o.notes || '',
      'Alasan Refund': o.refundReason || '',
      'Outlet': o.outletId,
    }))
    exportToCSV(rows, 'laporan_transaksi')
  }

  // Export shifts
  const exportShifts = () => {
    const rows = filteredShifts.map(s => ({
      'Kasir': s.cashierName,
      'Outlet': outlets.find(o => o.id === s.outletId)?.name || s.outletId,
      'Dibuka': s.openedAt ? format(parseISO(s.openedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
      'Ditutup': s.closedAt ? format(parseISO(s.closedAt), 'dd/MM/yyyy HH:mm', { locale: idLocale }) : '-',
      'Status': s.status,
      'Kas Awal': s.startingCash,
      'Kas Akhir': s.closingCash || 0,
      'Total Penjualan': s.totalSales,
      'Total Refund': s.totalRefunds || 0,
      'Jumlah Transaksi': s.totalOrders,
      'Tunai': s.cashSales,
      'Kartu': s.cardSales,
      'Transfer': s.transferSales,
      'QRIS': s.qrisSales,
    }))
    exportToCSV(rows, 'laporan_shift')
  }

  const getOutletName = (id: string) => outlets.find(o => o.id === id)?.name || id

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-50 text-green-700'
      case 'refunded': return 'bg-red-50 text-red-600'
      default: return 'bg-gray-100 text-gray-500'
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-black text-gray-900">Laporan</h2>
          <p className="text-sm text-gray-400">Ekspor data untuk analisis lebih lanjut</p>
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1">
          {(['transactions', 'shifts'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              {tab === 'transactions' ? 'Transaksi' : 'Shift'}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-black text-gray-400 mb-1">Dari</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-black text-gray-400 mb-1">Sampai</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs font-black text-gray-400 mb-1">Outlet</label>
          <select value={filterOutlet} onChange={e => setFilterOutlet(e.target.value)}
            className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Semua Outlet</option>
            {outlets.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        {activeTab === 'transactions' && (
          <>
            <div>
              <label className="block text-xs font-black text-gray-400 mb-1">Status</label>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none">
                <option value="">Semua Status</option>
                <option value="completed">Selesai</option>
                <option value="refunded">Refund</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-black text-gray-400 mb-1">Pembayaran</label>
              <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)}
                className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none">
                <option value="">Semua</option>
                <option value="cash">Tunai</option>
                <option value="card">Kartu</option>
                <option value="qris">QRIS</option>
                <option value="transfer">Transfer</option>
              </select>
            </div>
          </>
        )}
        <button onClick={activeTab === 'transactions' ? exportTransactions : exportShifts}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl text-sm transition-all">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* TRANSACTIONS VIEW */}
      {activeTab === 'transactions' && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(totalRevenue), icon: <TrendingUp className="w-4 h-4" />, color: 'text-green-600 bg-green-50' },
              { label: 'Jumlah Transaksi', value: completedOrders.length.toString(), icon: <ShoppingBag className="w-4 h-4" />, color: 'text-indigo-600 bg-indigo-50' },
              { label: 'Total Refund', value: BRAND.currency.format(totalRefunds), icon: <RotateCcw className="w-4 h-4" />, color: 'text-red-600 bg-red-50' },
              { label: 'Transaksi Direfund', value: refundedOrders.length.toString(), icon: <RotateCcw className="w-4 h-4" />, color: 'text-orange-600 bg-orange-50' },
            ].map(card => (
              <div key={card.label} className="bg-white rounded-2xl border border-gray-100 p-4">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center mb-2 ${card.color}`}>{card.icon}</div>
                <p className="text-xl font-black text-gray-900">{card.value}</p>
                <p className="text-xs text-gray-400">{card.label}</p>
              </div>
            ))}
          </div>

          {/* Payment breakdown */}
          {Object.keys(paymentBreakdown).length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <h3 className="font-black text-gray-900 mb-3">Breakdown Pembayaran</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(paymentBreakdown).map(([method, amount]) => (
                  <div key={method} className="bg-gray-50 rounded-xl p-3">
                    <p className="text-xs font-bold text-gray-500 capitalize mb-1">{method}</p>
                    <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(amount)}</p>
                    <p className="text-xs text-gray-400">{totalRevenue > 0 ? Math.round((amount / totalRevenue) * 100) : 0}%</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transaction list */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-sm font-bold text-gray-500">{filteredOrders.length} transaksi</p>
            </div>
            {filteredOrders.length === 0 ? (
              <div className="p-8 text-center text-gray-300"><ShoppingBag className="w-10 h-10 mx-auto mb-2" /><p>Tidak ada transaksi</p></div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
                {filteredOrders.map(order => (
                  <div key={order.id}>
                    <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-all"
                      onClick={() => setExpandedId(expandedId === order.id ? null : order.id!)}>
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${order.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                        <ShoppingBag className={`w-4 h-4 ${order.status === 'refunded' ? 'text-red-400' : 'text-indigo-500'}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                        <p className="text-xs text-gray-400">
                          {format(parseISO(order.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · {order.cashierName}
                          {order.salesmanName && ` · ${order.salesmanName}`}
                          {order.customerName && ` · ${order.customerName}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`px-2 py-0.5 text-xs font-bold rounded-lg ${statusBadge(order.status)}`}>
                          {order.status === 'completed' ? 'Selesai' : order.status === 'refunded' ? 'Refund' : order.status}
                        </span>
                        <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                        {expandedId === order.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                      </div>
                    </div>
                    {expandedId === order.id && (
                      <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                        <div className="pt-3 space-y-1">
                          {order.items.map((item, i) => (
                            <div key={i} className="flex justify-between text-sm">
                              <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                              <span className="font-bold text-gray-900">{BRAND.currency.format(item.subtotal)}</span>
                            </div>
                          ))}
                          <div className="border-t border-gray-200 pt-2 flex justify-between font-black text-gray-900">
                            <span>Total</span><span>{BRAND.currency.format(order.total)}</span>
                          </div>
                          {order.notes && <p className="text-xs text-gray-500 bg-yellow-50 rounded-lg px-2 py-1">📝 {order.notes}</p>}
                          {order.refundReason && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1">↩ {order.refundReason}</p>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* SHIFTS VIEW */}
      {activeTab === 'shifts' && (
        <>
          {/* Shift summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Penjualan', value: BRAND.currency.format(filteredShifts.reduce((s, sh) => s + sh.totalSales, 0)) },
              { label: 'Total Transaksi', value: filteredShifts.reduce((s, sh) => s + sh.totalOrders, 0).toString() },
              { label: 'Total Refund', value: BRAND.currency.format(filteredShifts.reduce((s, sh) => s + (sh.totalRefunds || 0), 0)) },
              { label: 'Jumlah Shift', value: filteredShifts.length.toString() },
            ].map(card => (
              <div key={card.label} className="bg-white rounded-2xl border border-gray-100 p-4">
                <p className="text-xl font-black text-gray-900">{card.value}</p>
                <p className="text-xs text-gray-400">{card.label}</p>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {filteredShifts.length === 0 ? (
              <div className="p-8 text-center text-gray-300"><p>Tidak ada shift</p></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Kasir', 'Outlet', 'Dibuka', 'Ditutup', 'Transaksi', 'Refund', 'Penjualan', 'Tunai', 'QRIS', 'Transfer', 'Kartu'].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-black text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filteredShifts.map(s => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-bold text-gray-900 text-sm">{s.cashierName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{getOutletName(s.outletId)}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.openedAt ? format(parseISO(s.openedAt), 'dd MMM HH:mm', { locale: idLocale }) : '-'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{s.closedAt ? format(parseISO(s.closedAt), 'dd MMM HH:mm', { locale: idLocale }) : <span className="text-green-600 font-bold">Buka</span>}</td>
                        <td className="px-4 py-3 text-sm font-bold text-gray-900">{s.totalOrders}</td>
                        <td className="px-4 py-3 text-sm font-bold text-red-600">{BRAND.currency.format(s.totalRefunds || 0)}</td>
                        <td className="px-4 py-3 text-sm font-black text-indigo-600">{BRAND.currency.format(s.totalSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.cashSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.qrisSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.transferSales)}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{BRAND.currency.format(s.cardSales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}