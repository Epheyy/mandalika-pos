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
import { ShoppingBag, TrendingUp, Package, Users, ArrowUpRight } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useOutlet } from '../outlet'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { BRAND } from '../lib/brand'
import {
  Card,
  Modal,
  PageHeader,
  CHART_PRIMARY,
  CHART_SERIES,
  CHART_GRID,
  CHART_AXIS,
  CHART_TOOLTIP,
} from '../ui'

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
  const selOrders = selected ? completed.filter((o) => o.cashierId === selected) : []

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={`Selamat datang, ${user?.displayName.split(' ')[0]} 👋`}
        subtitle={format(new Date(), 'EEEE, d MMMM yyyy', { locale: id })}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Penjualan Hari Ini" value={BRAND.currency.format(sum(today))} sub={`${today.length} transaksi`} icon={<TrendingUp className="w-5 h-5" />} />
        <StatCard label="Minggu Ini" value={BRAND.currency.format(sum(week))} sub={`${week.length} transaksi`} icon={<ShoppingBag className="w-5 h-5" />} />
        <StatCard label="Bulan Ini" value={BRAND.currency.format(sum(month))} sub={`${month.length} transaksi`} icon={<Package className="w-5 h-5" />} />
        <StatCard label="Total Semua Waktu" value={BRAND.currency.format(sum(completed))} sub={`${completed.length} transaksi`} icon={<Users className="w-5 h-5" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-5">
          <h3 className="font-black text-gray-900 mb-4">Penjualan 7 Hari Terakhir</h3>
          {last7.every((d) => d.revenue === 0) ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data penjualan
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={last7} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fontWeight: 700, fill: CHART_AXIS }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={rb} tick={{ fontSize: 11, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={60} />
                <Tooltip formatter={(v) => [BRAND.currency.format(Number(v)), 'Penjualan']} contentStyle={CHART_TOOLTIP} />
                <Bar dataKey="revenue" fill={CHART_PRIMARY} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="font-black text-gray-900 mb-4">Performa Kasir</h3>
          {top.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-gray-300 text-sm">
              Belum ada data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={top} layout="vertical" barSize={14} margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: CHART_AXIS }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fontWeight: 700, fill: CHART_AXIS }} axisLine={false} tickLine={false} width={70} />
                <Tooltip formatter={(v) => [`${v} transaksi`, 'Transaksi']} contentStyle={CHART_TOOLTIP} />
                <Bar dataKey="transactions" radius={[0, 4, 4, 0]} cursor="pointer" onClick={(d: { id?: string }) => setSelected(d.id ?? null)}>
                  {top.map((_, i) => (
                    <Cell key={i} fill={CHART_SERIES[i % CHART_SERIES.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <Card className="overflow-hidden">
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
                  <div className="w-9 h-9 bg-gold-50 rounded-xl flex items-center justify-center">
                    <ShoppingBag className="w-4 h-4 text-gold-600" />
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
                  <p className="text-xs text-gray-400 font-bold">{o.cashierName}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        size="lg"
        padded={false}
        title={selected ? byCashier[selected]?.name : ''}
        subtitle={
          selected ? `${selOrders.length} transaksi · ${BRAND.currency.format(sum(selOrders))}` : undefined
        }
      >
        <div className="divide-y divide-gray-50">
          {selOrders.map((o) => (
            <div key={o.id} className="px-6 py-3 flex items-center justify-between">
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
      </Modal>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
}) {
  return (
    <Card className="p-5 hover:shadow-md transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gold-50 text-gold-600">
          {icon}
        </div>
        <ArrowUpRight className="w-4 h-4 text-gray-300" />
      </div>
      <p className="text-2xl font-black text-gray-900 leading-none mb-1">{value}</p>
      <p className="text-xs font-bold text-gray-400">{label}</p>
      <p className="text-xs text-gray-300 mt-0.5">{sub}</p>
    </Card>
  )
}
