import { useState, useEffect } from 'react'
import type { AppUser, Order } from '../../../types'
import { OrderStatus } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { ShoppingBag, TrendingUp, Package, Users, ArrowUpRight, X } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell
} from 'recharts'
import { format, isToday, isThisWeek, isThisMonth, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'

interface Props { appUser: AppUser }

const formatRupiah = (value: number) =>
  `Rp ${(value / 1000).toFixed(0)}rb`

export default function Dashboard({ appUser }: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedSalesman, setSelectedSalesman] = useState<string | null>(null)

  useEffect(() => {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Order))
      setOrders(data)
      setIsLoading(false)
    })
    return () => unsub()
  }, [])

  const completedOrders = orders.filter(o => o.status === OrderStatus.COMPLETED)

  const todayOrders = completedOrders.filter(o => isToday(parseISO(o.createdAt)))
  const weekOrders = completedOrders.filter(o => isThisWeek(parseISO(o.createdAt), { weekStartsOn: 1 }))
  const monthOrders = completedOrders.filter(o => isThisMonth(parseISO(o.createdAt)))

  const todayRevenue = todayOrders.reduce((s, o) => s + o.total, 0)
  const weekRevenue = weekOrders.reduce((s, o) => s + o.total, 0)
  const monthRevenue = monthOrders.reduce((s, o) => s + o.total, 0)
  const totalAllRevenue = completedOrders.reduce((s, o) => s + o.total, 0)

  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - i))
    const dateStr = format(date, 'yyyy-MM-dd')
    const label = format(date, 'EEE', { locale: id })
    const dayOrders = completedOrders.filter(o => o.createdAt.startsWith(dateStr))
    const revenue = dayOrders.reduce((s, o) => s + o.total, 0)
    return { label, revenue, orders: dayOrders.length }
  })

  const recentOrders = completedOrders.slice(0, 5)

  // ── Top Salesman (by cashier) ────────────
  const salesmanMap = completedOrders.reduce((acc, o) => {
    const key = o.cashierId
    const name = o.cashierName
    if (!acc[key]) acc[key] = { id: key, name, transactions: 0, revenue: 0 }
    acc[key].transactions++
    acc[key].revenue += o.total
    return acc
  }, {} as Record<string, { id: string; name: string; transactions: number; revenue: number }>)

  const topSalesmen = Object.values(salesmanMap)
    .sort((a, b) => b.transactions - a.transactions)
    .slice(0, 8)

  const COLORS = ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#e0e7ff', '#6366f1', '#818cf8', '#a5b4fc']

  const selectedSalesmanOrders = selectedSalesman
    ? completedOrders.filter(o => o.cashierId === selectedSalesman)
    : []

  if (isLoading) {
    return (
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 animate-pulse h-28" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── Greeting ── */}
      <div>
        <h2 className="text-2xl font-black text-gray-900">
          Selamat datang, {appUser.displayName.split(' ')[0]} 👋
        </h2>
        <p className="text-gray-400 text-sm mt-1">
          {format(new Date(), "EEEE, d MMMM yyyy", { locale: id })}
        </p>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Penjualan Hari Ini" value={BRAND.currency.format(todayRevenue)} sub={`${todayOrders.length} transaksi`} icon={<TrendingUp className="w-5 h-5" />} color="indigo" />
        <StatCard label="Minggu Ini" value={BRAND.currency.format(weekRevenue)} sub={`${weekOrders.length} transaksi`} icon={<ShoppingBag className="w-5 h-5" />} color="violet" />
        <StatCard label="Bulan Ini" value={BRAND.currency.format(monthRevenue)} sub={`${monthOrders.length} transaksi`} icon={<Package className="w-5 h-5" />} color="blue" />
        <StatCard label="Total Semua Waktu" value={BRAND.currency.format(totalAllRevenue)} sub={`${completedOrders.length} transaksi`} icon={<Users className="w-5 h-5" />} color="sky" />
      </div>

      {/* ── Chart + Top Salesman ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Revenue Bar Chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl p-5 border border-gray-100">
          <h3 className="font-black text-gray-900 mb-4">Penjualan 7 Hari Terakhir</h3>
          {last7Days.every(d => d.revenue === 0) ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">Belum ada data penjualan</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={last7Days} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fontWeight: 700, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={formatRupiah} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={60} />
                <Tooltip
                  formatter={(value: any) => [BRAND.currency.format(Number(value)), 'Penjualan']}
                  labelStyle={{ fontWeight: 700 }}
                  contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}
                />
                <Bar dataKey="revenue" fill="#6366f1" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top Salesman */}
        <div className="bg-white rounded-2xl p-5 border border-gray-100">
          <h3 className="font-black text-gray-900 mb-4">Performa Kasir</h3>
          {topSalesmen.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">Belum ada data</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topSalesmen} layout="vertical" barSize={14} margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fontWeight: 700, fill: '#6b7280' }} axisLine={false} tickLine={false} width={70} />
                <Tooltip
                  formatter={(value: any, name: any) => [name === 'transactions' ? `${value} transaksi` : BRAND.currency.format(Number(value)), name === 'transactions' ? 'Transaksi' : 'Revenue']}
                  contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}
                />
                <Bar dataKey="transactions" radius={[0, 4, 4, 0]} cursor="pointer"
                  onClick={(data) => setSelectedSalesman(data.id ?? null)}>
                  {topSalesmen.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {topSalesmen.length > 0 && (
            <p className="text-xs text-gray-400 mt-2 text-center">Klik bar untuk lihat detail transaksi</p>
          )}
        </div>
      </div>

      {/* ── Recent Orders ── */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-black text-gray-900">Transaksi Terbaru</h3>
          <span className="text-xs font-bold text-gray-400">{completedOrders.length} total</span>
        </div>
        {recentOrders.length === 0 ? (
          <div className="p-8 text-center text-gray-300 text-sm">Belum ada transaksi. Buat transaksi di halaman Kasir.</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {recentOrders.map(order => (
              <div key={order.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50 transition-all">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                    <ShoppingBag className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{order.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {order.items.length} item · <span className="capitalize">{order.paymentMethod}</span> · {format(parseISO(order.createdAt), 'HH:mm', { locale: id })}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-black text-gray-900">{BRAND.currency.format(order.total)}</p>
                  <p className="text-xs text-green-500 font-bold">{order.cashierName}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Salesman Detail Modal ── */}
      {selectedSalesman && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">
                  {salesmanMap[selectedSalesman]?.name}
                </h2>
                <p className="text-xs text-gray-400">
                  {selectedSalesmanOrders.length} transaksi · {BRAND.currency.format(selectedSalesmanOrders.reduce((s, o) => s + o.total, 0))}
                </p>
              </div>
              <button onClick={() => setSelectedSalesman(null)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
              {selectedSalesmanOrders.length === 0 ? (
                <div className="p-12 text-center text-gray-300">Belum ada transaksi</div>
              ) : selectedSalesmanOrders.map(order => (
                <div key={order.id} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {format(parseISO(order.createdAt), 'dd MMM yyyy HH:mm', { locale: id })} · <span className="capitalize">{order.paymentMethod}</span> · {order.items.length} item
                    </p>
                  </div>
                  <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function StatCard({ label, value, sub, icon, color }: {
  label: string; value: string; sub: string; icon: React.ReactNode
  color: 'indigo' | 'violet' | 'blue' | 'sky'
}) {
  const colorMap = {
    indigo: 'bg-indigo-50 text-indigo-600', violet: 'bg-violet-50 text-violet-600',
    blue: 'bg-blue-50 text-blue-600', sky: 'bg-sky-50 text-sky-600',
  }
  return (
    <div className="bg-white rounded-2xl p-5 border border-gray-100 hover:shadow-md transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colorMap[color]}`}>{icon}</div>
        <ArrowUpRight className="w-4 h-4 text-gray-200" />
      </div>
      <p className="text-2xl font-black text-gray-900 leading-none mb-1">{value}</p>
      <p className="text-xs font-bold text-gray-400">{label}</p>
      <p className="text-xs text-gray-300 mt-0.5">{sub}</p>
    </div>
  )
}
