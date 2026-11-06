import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from 'recharts'
import { compactRupiah, isAllZero } from '../../lib/axisFormat'
import { BRAND } from '../../lib/brand'
import {
  CHART_PRIMARY,
  CHART_SERIES,
  CHART_GRID,
  CHART_AXIS,
  CHART_TOOLTIP,
  chartAnimates,
} from '../../ui/chartColors'
import type { TrendPoint, PayRow, CashierRow } from './metrics'


interface TrendChartProps {
  trend: TrendPoint[]
}

/** Tren Penjualan — daily/hourly/monthly net revenue bars (a refund day can be negative). */
export function TrendChart({ trend }: TrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={trend}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fontWeight: 700, fill: CHART_AXIS }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={compactRupiah}
          tick={{ fontSize: 11, fill: CHART_AXIS }}
          axisLine={false}
          tickLine={false}
          width={72}
          hide={isAllZero(trend.map((p) => p.revenue))}
        />
        <Tooltip
          formatter={(v) => [BRAND.currency.format(Number(v)), 'Penjualan']}
          contentStyle={CHART_TOOLTIP}
          cursor={{ fill: 'rgba(176,125,24,0.08)' }}
        />
        <ReferenceLine y={0} stroke={CHART_AXIS} strokeWidth={1} />
        <Bar dataKey="revenue" fill={CHART_PRIMARY} radius={[4, 4, 0, 0]} isAnimationActive={chartAnimates()} />
      </BarChart>
    </ResponsiveContainer>
  )
}

interface PaymentChartProps {
  pay: PayRow[]
}

/** Metode Pembayaran — donut of payment-method amounts. */
export function PaymentChart({ pay }: PaymentChartProps) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <PieChart>
        <Pie
          data={pay}
          dataKey="amount"
          nameKey="label"
          innerRadius={42}
          outerRadius={66}
          paddingAngle={2}
          stroke="none"
          isAnimationActive={chartAnimates()}
        >
          {pay.map((p, i) => (
            <Cell key={p.method} fill={CHART_SERIES[i % CHART_SERIES.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v) => BRAND.currency.format(Number(v))}
          contentStyle={CHART_TOOLTIP}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

interface CashierChartProps {
  cashiers: CashierRow[]
}

/** Performa Kasir — horizontal transaction bars per cashier. */
export function CashierChart({ cashiers }: CashierChartProps) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, cashiers.length * 36)}>
      <BarChart
        data={cashiers}
        layout="vertical"
        barSize={16}
        margin={{ left: 0, right: 24, top: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: CHART_AXIS }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fontWeight: 700, fill: CHART_AXIS }}
          axisLine={false}
          tickLine={false}
          width={90}
        />
        <Tooltip
          formatter={(v, n) => [
            n === 'revenue' ? BRAND.currency.format(Number(v)) : `${v} transaksi`,
            n === 'revenue' ? 'Penjualan' : 'Transaksi',
          ]}
          contentStyle={CHART_TOOLTIP}
          cursor={{ fill: 'rgba(176,125,24,0.08)' }}
        />
        {/* One measure, one colour: a cashier is named on the axis, so a hue per bar would say nothing. */}
        <Bar dataKey="transactions" fill={CHART_PRIMARY} radius={[0, 4, 4, 0]} isAnimationActive={chartAnimates()} />
      </BarChart>
    </ResponsiveContainer>
  )
}

const Charts = { TrendChart, PaymentChart, CashierChart }
export default Charts
