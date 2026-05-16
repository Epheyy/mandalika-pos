import { useState } from 'react'
import type { Order } from '@mandalika/api'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { format, isToday, isThisWeek, isThisMonth, parseISO } from 'date-fns'
import { id } from 'date-fns/locale'
import { ShoppingBag, TrendingUp, Package, Users, ArrowUpRight, X } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { BRAND } from '../lib/brand'

const rb = (v: number) => `Rp ${(v / 1000).toFixed(0)}rb`

export default function Dashboard() {
  const { user } = useAuth()
  const { outletId } = useOutlet()
  const [selected, setSelected] = useState<string | null>(null)

  const q = usePolledQuery<Order[]>(
    () => api.listOrders({ limit: 500 }).then((r) => r.data),
    [outletId],
  )
  const orders = q.data ?? []
  const completed = orders.filter((o) => o.status === 'completed')

  if (q.loading)
    return (
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 animate-pulse h-28" />
        ))}
      </div>
    )

  const today = completed.filter((o) => isToday(parseISO(o.createdAt)))
  const week = completed.filter((o) =>
    isThisWeek(parseISO(o.createdAt), { weekStartsOn: 1 }),
  )
  const month = completed.filter((o) => isThisMonth(parseISO(o.createdAt)))
  const sum = (xs: Order[]) => xs.reduce((s, o) => s + o.total, 0)

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    const ds = format(d, 'yyyy-MM-dd')
    const dayO = completed.filter((o) => o.createdAt.startsWith(ds))
    return {
      label: format(d, 'EEE', { locale: id }),
      revenue: sum(dayO),
      orders: dayO.length,
    }
  })

  const byCashier = completed.reduce<
    Record<string, { id: string; name: string; transactions: number; revenue: number }>
  >((acc, o) => {
    const k = o.cashierId
    if (!acc[k]) acc[k] = { id: k, name: o.cashierName, transactions: 0, revenue: 0 }
    acc[k].transactions++
    acc[k].revenue += o.total
    return acc
  }, {})
  const top = Object.values(byCashier)
    .sort((a, b) => b.transactions - a.transactions)
    .slice(0, 8)
  const COLORS = ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#e0e7ff', '#6366f1', '#818cf8', '#a5b4fc']
  const selOrders = selected ? completed.filter((o) => o.cashierId === selected) : []

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-black text-gray-900">
          Selamat datang, {user?.displayName.split(' ')[0]} 👋
        </h2>
        <p className="text-gray-400 text-sm mt-1">
          {format(new Date(), 'EEEE, d MMMM yyyy', { locale: id })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Penjualan Hari Ini" value={BRAND.currency.format(sum(today))} sub={`${today.length} transaksi`} icon={<TrendingUp className="w-5 h-5" />} color="indigo" />
        <StatCard label="Minggu Ini" value={BRAND.currency.format(sum(week))} sub={`${week.length} transaksi`} icon={<ShoppingBag className="w-5 h-5" />} color="violet" />
        <StatCard label="Bulan Ini" value={BRAND.currency.format(sum(month))} sub={`${month.length} transaksi`} icon={<Package className="w-5 h-5" />} color="blue" />
        <StatCard label="Total Semua Waktu" value={BRAND.currency.format(sum(completed))} sub={`${completed.length} transaksi`} icon={<Users className="w-5 h-5" />} color="sky" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-2xl p-5 border border-gray-100">
          <h3 className="font-black text-gray-900 mb-4">Penjualan 7 Hari Terakhir</h3>
          {last7.every((d) => d.revenue === 0) ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data penjualan
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={last7} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fontWeight: 700, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={rb} tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={60} />
                <Tooltip formatter={(v) => [BRAND.currency.format(Number(v)), 'Penjualan']} contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }} />
                <Bar dataKey="revenue" fill="#6366f1" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-100">
          <h3 className="font-black text-gray-900 mb-4">Performa Kasir</h3>
          {top.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={top} layout="vertical" barSize={14} margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fontWeight: 700, fill: '#6b7280' }} axisLine={false} tickLine={false} width={70} />
                <Tooltip formatter={(v) => [`${v} transaksi`, 'Transaksi']} contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }} />
                <Bar dataKey="transactions" radius={[0, 4, 4, 0]} cursor="pointer" onClick={(d: { id?: string }) => setSelected(d.id ?? null)}>
                  {top.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-black text-gray-900">Transaksi Terbaru</h3>
          <span className="text-xs font-bold text-gray-400">{completed.length} total</span>
        </div>
        {completed.slice(0, 5).length === 0 ? (
          <div className="p-8 text-center text-gray-300 text-sm">
            Belum ada transaksi.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {completed.slice(0, 5).map((o) => (
              <div key={o.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center">
                    <ShoppingBag className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{o.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {o.items.length} item · <span className="capitalize">{o.paymentMethod}</span> · {format(parseISO(o.createdAt), 'HH:mm', { locale: id })}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-black text-gray-900">{BRAND.currency.format(o.total)}</p>
                  <p className="text-xs text-green-500 font-bold">{o.cashierName}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">{byCashier[selected]?.name}</h2>
                <p className="text-xs text-gray-400">
                  {selOrders.length} transaksi · {BRAND.currency.format(sum(selOrders))}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
              {selOrders.map((o) => (
                <div key={o.id} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                    <p className="text-xs text-gray-400">
                      {format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: id })} · {o.items.length} item
                    </p>
                  </div>
                  <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon,
  color,
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
  color: 'indigo' | 'violet' | 'blue' | 'sky'
}) {
  const cm = {
    indigo: 'bg-indigo-50 text-indigo-600',
    violet: 'bg-violet-50 text-violet-600',
    blue: 'bg-blue-50 text-blue-600',
    sky: 'bg-sky-50 text-sky-600',
  }
  return (
    <div className="bg-white rounded-2xl p-5 border border-gray-100 hover:shadow-md transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cm[color]}`}>{icon}</div>
        <ArrowUpRight className="w-4 h-4 text-gray-200" />
      </div>
      <p className="text-2xl font-black text-gray-900 leading-none mb-1">{value}</p>
      <p className="text-xs font-bold text-gray-400">{label}</p>
      <p className="text-xs text-gray-300 mt-0.5">{sub}</p>
    </div>
  )
}
