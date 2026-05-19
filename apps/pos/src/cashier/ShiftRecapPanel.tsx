/**
 * Shift recap — "Rekap" shows the active shift's payment-method breakdown,
 * cash-drawer reconciliation and cash-flow entries; "Riwayat" lists past
 * shifts with the same breakdown on drill-down. All data server-sourced.
 */
import { useCallback, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { formatRupiah } from './pricing'

type Shift = components['schemas']['Shift']
type CashFlow = components['schemas']['CashFlow']
type Order = components['schemas']['Order']
type ShiftResponse = components['schemas']['ShiftResponse']
type ShiftListResponse = components['schemas']['ShiftListResponse']
type CashFlowListResponse = components['schemas']['CashFlowListResponse']
type OrderListResponse = components['schemas']['OrderListResponse']
type PaymentMethodCfg = { id: string; label: string; isEnabled: boolean }

// Live per-method/totals breakdown for an OPEN shift (the stored shift.*Sales
// columns are only reconciled by the server at close, so an active shift would
// otherwise show all zeros).
interface LiveBreakdown {
  byMethod: Record<string, number>
  totalSales: number
  totalOrders: number
  totalRefunds: number
  cashSales: number
}

function aggregate(orders: Order[]): LiveBreakdown {
  const b: LiveBreakdown = {
    byMethod: {},
    totalSales: 0,
    totalOrders: 0,
    totalRefunds: 0,
    cashSales: 0,
  }
  for (const o of orders) {
    if (o.status === 'refunded') {
      b.totalRefunds += o.total
      continue
    }
    if (o.status === 'cancelled') continue
    b.totalSales += o.total
    b.totalOrders += 1
    b.byMethod[o.paymentMethod] = (b.byMethod[o.paymentMethod] ?? 0) + o.total
    if (o.paymentMethod === 'cash') b.cashSales += o.total
  }
  return b
}

interface ShiftRecapPanelProps {
  isOpen: boolean
  onClose: () => void
  paymentMethods: PaymentMethodCfg[]
}

type Tab = 'rekap' | 'riwayat'

function fmtTime(s?: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleString('id-ID', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function isCashOut(t: string): boolean {
  return t === 'out' || t === 'expense' || t === 'withdrawal'
}

function ShiftBreakdown({
  shift,
  flows,
  live,
  paymentMethods,
}: {
  shift: Shift
  flows: CashFlow[]
  live?: LiveBreakdown
  paymentMethods: PaymentMethodCfg[]
}) {
  const cashIn = flows.filter((f) => !isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  const cashOut = flows.filter((f) => isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  // Active shift → live order aggregation; closed shift → server-reconciled
  // columns. Build the rendered numbers from whichever applies.
  const cashSales = live ? live.cashSales : shift.cashSales
  const totalSales = live ? live.totalSales : shift.totalSales
  const totalOrders = live ? live.totalOrders : shift.totalOrders
  const totalRefunds = live ? live.totalRefunds : shift.totalRefunds
  // Method rows: every configured method, plus any method seen in orders that
  // isn't configured (so nothing is hidden).
  const methodAmount = (id: string): number =>
    live
      ? (live.byMethod[id] ?? 0)
      : id === 'cash'
        ? shift.cashSales
        : id === 'card'
          ? shift.cardSales
          : id === 'transfer'
            ? shift.transferSales
            : id === 'qris'
              ? shift.qrisSales
              : 0
  const methodRows: { id: string; label: string }[] = [
    ...paymentMethods.map((m) => ({ id: m.id, label: m.label })),
    ...Object.keys(live?.byMethod ?? {})
      .filter((id) => !paymentMethods.some((m) => m.id === id))
      .map((id) => ({ id, label: id })),
  ]
  const expectedCash = shift.startingCash + cashSales + cashIn - cashOut
  const variance =
    shift.closingCash != null ? shift.closingCash - expectedCash : null

  const row = (label: string, val: string, accent = false) => (
    <div className="flex justify-between text-sm py-1">
      <span className="text-gray-600">{label}</span>
      <span className={accent ? 'font-bold text-gray-900' : 'text-gray-800'}>{val}</span>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-xl p-3">
        <p className="text-[11px] text-gray-500 mb-1">
          {shift.cashierName} · {shift.outletName ?? ''}
        </p>
        <p className="text-[11px] text-gray-500">
          Buka {fmtTime(shift.openedAt)} · Tutup {fmtTime(shift.closedAt)}
        </p>
        <span
          className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
            shift.status === 'open'
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-200 text-gray-600'
          }`}
        >
          {shift.status === 'open' ? 'Aktif' : 'Ditutup'}
        </span>
      </div>

      <div className="border border-gray-100 rounded-xl p-3">
        <p className="text-xs font-bold text-gray-700 mb-1">Penjualan per Metode</p>
        {methodRows.map((m) => (
          <div key={m.id}>{row(m.label, formatRupiah(methodAmount(m.id)))}</div>
        ))}
        <div className="border-t border-dashed border-gray-200 mt-1 pt-1">
          {row('Total Penjualan', formatRupiah(totalSales), true)}
        </div>
        {row('Jumlah Order', String(totalOrders))}
        {row('Refund', formatRupiah(totalRefunds))}
      </div>

      <div className="border border-gray-100 rounded-xl p-3">
        <p className="text-xs font-bold text-gray-700 mb-1">Rekonsiliasi Kas</p>
        {row('Kas Awal', formatRupiah(shift.startingCash))}
        {row('Penjualan Tunai', formatRupiah(cashSales))}
        {row('Kas Masuk', formatRupiah(cashIn))}
        {row('Kas Keluar', `−${formatRupiah(cashOut)}`)}
        <div className="border-t border-dashed border-gray-200 mt-1 pt-1">
          {row('Kas Seharusnya', formatRupiah(expectedCash), true)}
        </div>
        {shift.closingCash != null && row('Kas Aktual', formatRupiah(shift.closingCash))}
        {variance != null && (
          <div
            className={`flex justify-between text-sm py-1 font-bold ${
              variance === 0
                ? 'text-gray-900'
                : variance > 0
                  ? 'text-green-600'
                  : 'text-red-600'
            }`}
          >
            <span>Selisih</span>
            <span>
              {variance > 0 ? '+' : ''}
              {formatRupiah(variance)}
            </span>
          </div>
        )}
      </div>

      {flows.length > 0 && (
        <div className="border border-gray-100 rounded-xl p-3">
          <p className="text-xs font-bold text-gray-700 mb-1">Arus Kas</p>
          {flows.map((f) => (
            <div key={f.id} className="flex justify-between text-xs py-1">
              <span className="text-gray-600 truncate mr-2">
                {f.description || f.type}
              </span>
              <span className={isCashOut(f.type) ? 'text-red-600' : 'text-green-600'}>
                {isCashOut(f.type) ? '−' : '+'}
                {formatRupiah(f.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ShiftRecapPanel({ isOpen, onClose, paymentMethods }: ShiftRecapPanelProps) {
  const [tab, setTab] = useState<Tab>('rekap')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [currentFlows, setCurrentFlows] = useState<CashFlow[]>([])
  const [currentLive, setCurrentLive] = useState<LiveBreakdown | undefined>(undefined)

  const [history, setHistory] = useState<Shift[]>([])
  const [selected, setSelected] = useState<Shift | null>(null)
  const [selectedFlows, setSelectedFlows] = useState<CashFlow[]>([])

  const flowsFor = useCallback(async (shiftId: string): Promise<CashFlow[]> => {
    const r = await api.request<CashFlowListResponse>(
      'GET', `/api/v1/cash-flows?shiftId=${encodeURIComponent(shiftId)}&limit=200`,
    )
    return r.data ?? []
  }, [])

  const loadRekap = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const r = await api.request<ShiftResponse>('GET', '/api/v1/shifts/current')
      const s = r.data ?? null
      setCurrentShift(s)
      if (s) {
        setCurrentFlows(await flowsFor(s.id))
        // Active shift totals are computed live from its orders (the stored
        // shift columns are only reconciled by the server at close).
        const ord = await api.request<OrderListResponse>(
          'GET',
          `/api/v1/orders?shiftId=${encodeURIComponent(s.id)}&page=1&limit=1000`,
        )
        setCurrentLive(aggregate(ord.data ?? []))
      } else {
        setCurrentFlows([])
        setCurrentLive(undefined)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memuat rekap')
    } finally {
      setIsLoading(false)
    }
  }, [flowsFor])

  const loadHistory = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const r = await api.request<ShiftListResponse>(
        'GET', '/api/v1/shifts?page=1&limit=30',
      )
      setHistory(r.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Gagal memuat riwayat shift')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    setSelected(null)
    if (tab === 'rekap') void loadRekap()
    else void loadHistory()
  }, [isOpen, tab, loadRekap, loadHistory])

  const openHistoryShift = async (s: Shift) => {
    setSelected(s)
    setSelectedFlows([])
    try {
      setSelectedFlows(await flowsFor(s.id))
    } catch {
      /* drawer still renders with sales breakdown */
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="font-bold text-gray-900">Rekap Shift</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            title="Tutup"
          >
            ✕
          </button>
        </div>

        <div className="flex border-b border-gray-100 flex-shrink-0">
          {(['rekap', 'riwayat'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm font-semibold ${
                tab === t
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'rekap' ? 'Rekap Aktif' : 'Riwayat'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading && <p className="text-sm text-gray-400 text-center py-8">Memuat…</p>}
          {error && <p className="text-sm text-red-600 text-center py-8">{error}</p>}

          {!isLoading && !error && tab === 'rekap' && (
            currentShift ? (
              <ShiftBreakdown
                shift={currentShift}
                flows={currentFlows}
                live={currentLive}
                paymentMethods={paymentMethods}
              />
            ) : (
              <p className="text-sm text-gray-400 text-center py-8">
                Belum ada shift aktif
              </p>
            )
          )}

          {!isLoading && !error && tab === 'riwayat' && !selected && (
            history.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">
                Belum ada riwayat shift
              </p>
            ) : (
              <div className="space-y-2">
                {history.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void openHistoryShift(s)}
                    className="w-full flex items-center justify-between px-3 py-2.5 border border-gray-200 rounded-xl text-left hover:bg-gray-50"
                  >
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        {fmtTime(s.openedAt)}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {s.cashierName} · {s.totalOrders} order
                      </p>
                    </div>
                    <span className="font-bold text-sm text-gray-900">
                      {formatRupiah(s.totalSales)}
                    </span>
                  </button>
                ))}
              </div>
            )
          )}

          {!isLoading && !error && tab === 'riwayat' && selected && (
            <div>
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-indigo-600 font-semibold mb-3 hover:underline"
              >
                ‹ Kembali ke daftar
              </button>
              <ShiftBreakdown
                shift={selected}
                flows={selectedFlows}
                paymentMethods={paymentMethods}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
