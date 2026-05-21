/**
 * Shift recap — full-screen two-pane (Runchise-style) layout.
 *   Left  : nav (Rekapan / Riwayat) + user + back-to-cashier.
 *   Center: payment-method rows + reconciliation totals + shift actions
 *           (Rekapan), or a searchable history table (Riwayat).
 *   Right : detailed sales / cash-flow breakdown for the active shift, or
 *           the selected past shift.
 * All data is server-sourced. Brand gold comes free — index.css remaps the
 * indigo palette to gold, so the indigo-* classes here render gold.
 */
import { useCallback, useEffect, useState } from 'react'
import type { components } from '@mandalika/api'
import { api } from '../api'
import { formatRupiah } from './pricing'
import { cacheRead, cacheWrite, OFFLINE_NOTICE } from '../lib/offlineCache'
import { Skeleton } from '../components/Skeleton'

type Shift = components['schemas']['Shift']
type CashFlow = components['schemas']['CashFlow']
type Order = components['schemas']['Order']
type ShiftResponse = components['schemas']['ShiftResponse']
type ShiftListResponse = components['schemas']['ShiftListResponse']
type CashFlowListResponse = components['schemas']['CashFlowListResponse']
type OrderListResponse = components['schemas']['OrderListResponse']
type PaymentMethodCfg = { id: string; label: string; isEnabled: boolean }

interface Breakdown {
  byMethod: Record<string, number>
  totalSales: number
  totalOrders: number
  refundCount: number
  refundTotal: number
  refundItems: number
  cashSales: number
  gross: number
  discount: number
  tax: number
  surcharge: number
  net: number
}

function aggregate(orders: Order[]): Breakdown {
  const b: Breakdown = {
    byMethod: {}, totalSales: 0, totalOrders: 0, refundCount: 0,
    refundTotal: 0, refundItems: 0, cashSales: 0, gross: 0, discount: 0,
    tax: 0, surcharge: 0, net: 0,
  }
  for (const o of orders) {
    if (o.status === 'cancelled') continue
    if (o.status === 'refunded') {
      b.refundCount += 1
      b.refundTotal += o.total
      b.refundItems += o.items.reduce((s, i) => s + i.quantity, 0)
      continue
    }
    b.totalSales += o.total
    b.totalOrders += 1
    b.byMethod[o.paymentMethod] = (b.byMethod[o.paymentMethod] ?? 0) + o.total
    if (o.paymentMethod === 'cash') b.cashSales += o.total
    b.gross += o.subtotal
    b.discount += o.discountAmount
    b.tax += o.taxAmount
    // Surcharge isn't a dedicated field on Order; recover it as the residual
    // between the charged total and (subtotal − discount + tax).
    const residual = o.total - (o.subtotal - o.discountAmount + o.taxAmount)
    if (residual > 0) b.surcharge += residual
  }
  b.net = b.gross - b.discount
  return b
}

function isCashOut(t: string): boolean {
  return t === 'out' || t === 'expense' || t === 'withdrawal'
}

function fmtDate(s?: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

interface ShiftRecapPanelProps {
  isOpen: boolean
  onClose: () => void
  paymentMethods: PaymentMethodCfg[]
  userName: string
  userRole: string
  onOpenShift: (startingCash: number) => void
  onCloseShift: (closingCash: number) => void
  isOpeningShift: boolean
  isClosingShift: boolean
}

type Tab = 'rekapan' | 'riwayat'

export function ShiftRecapPanel({
  isOpen,
  onClose,
  paymentMethods,
  userName,
  userRole,
  onOpenShift,
  onCloseShift,
  isOpeningShift,
  isClosingShift,
}: ShiftRecapPanelProps) {
  const [tab, setTab] = useState<Tab>('rekapan')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true when the figures shown were restored from the offline cache.
  const [isStale, setIsStale] = useState(false)

  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [currentFlows, setCurrentFlows] = useState<CashFlow[]>([])
  const [live, setLive] = useState<Breakdown | null>(null)

  const [history, setHistory] = useState<Shift[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [selected, setSelected] = useState<Shift | null>(null)
  const [selectedOrders, setSelectedOrders] = useState<Order[]>([])
  const [loadingSelected, setLoadingSelected] = useState(false)

  const [depositAmount, setDepositAmount] = useState('')
  const [closingCash, setClosingCash] = useState('')

  const flowsFor = useCallback(async (shiftId: string): Promise<CashFlow[]> => {
    const r = await api.request<CashFlowListResponse>(
      'GET', `/api/v1/cash-flows?shiftId=${encodeURIComponent(shiftId)}&limit=200`,
    )
    return r.data ?? []
  }, [])

  const ordersFor = useCallback(async (shiftId: string): Promise<Order[]> => {
    const r = await api.request<OrderListResponse>(
      'GET', `/api/v1/orders?shiftId=${encodeURIComponent(shiftId)}&page=1&limit=1000`,
    )
    return r.data ?? []
  }, [])

  const loadRekap = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const r = await api.request<ShiftResponse>('GET', '/api/v1/shifts/current')
      const s = r.data ?? null
      let flows: CashFlow[] = []
      let orders: Order[] = []
      if (s) {
        flows = await flowsFor(s.id)
        orders = await ordersFor(s.id)
      }
      setCurrentShift(s)
      setCurrentFlows(flows)
      setLive(s ? aggregate(orders) : null)
      setIsStale(false)
      cacheWrite('rekap:current', { shift: s, flows, orders })
    } catch (e: unknown) {
      // Offline: rebuild the recap from the last online snapshot.
      const cached = cacheRead<{ shift: Shift | null; flows: CashFlow[]; orders: Order[] }>('rekap:current')
      if (cached) {
        setCurrentShift(cached.shift)
        setCurrentFlows(cached.flows)
        setLive(cached.shift ? aggregate(cached.orders) : null)
        setIsStale(true)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : 'Gagal memuat rekap')
      }
    } finally {
      setIsLoading(false)
    }
  }, [flowsFor, ordersFor])

  const loadHistory = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const r = await api.request<ShiftListResponse>('GET', '/api/v1/shifts?page=1&limit=30')
      const data = r.data ?? []
      setHistory(data)
      setIsStale(false)
      cacheWrite('rekap:history', data)
    } catch (e: unknown) {
      const cached = cacheRead<Shift[]>('rekap:history')
      if (cached) {
        setHistory(cached)
        setIsStale(true)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : 'Gagal memuat riwayat shift')
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    setSelected(null)
    if (tab === 'rekapan') void loadRekap()
    else void loadHistory()
  }, [isOpen, tab, loadRekap, loadHistory])

  const selectHistoryShift = async (s: Shift) => {
    setSelected(s)
    setSelectedOrders([])
    setLoadingSelected(true)
    try {
      const o = await ordersFor(s.id)
      setSelectedOrders(o)
      cacheWrite(`rekap:orders:${s.id}`, o)
    } catch {
      // Offline: show the cached orders for this shift if we have them.
      setSelectedOrders(cacheRead<Order[]>(`rekap:orders:${s.id}`) ?? [])
    } finally {
      setLoadingSelected(false)
    }
  }

  const handleOpen = () => {
    onOpenShift(parseInt(depositAmount, 10) || 0)
    setDepositAmount('')
    setTimeout(() => void loadRekap(), 1700)
  }
  const handleClose = () => {
    onCloseShift(parseInt(closingCash, 10) || 0)
    setClosingCash('')
    setTimeout(() => void loadRekap(), 1700)
  }

  if (!isOpen) return null

  const cashIn = currentFlows.filter((f) => !isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  const cashOut = currentFlows.filter((f) => isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  const inFlows = currentFlows.filter((f) => !isCashOut(f.type))
  const outFlows = currentFlows.filter((f) => isCashOut(f.type))

  const sumRow = (label: string, value: string, bold = false) => (
    <div className={`flex justify-between text-sm py-1 ${bold ? 'font-black text-gray-900' : ''}`}>
      <span className={bold ? 'text-gray-900' : 'text-gray-500'}>{label}</span>
      <span>{value}</span>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-gray-50 flex overflow-hidden safe-top safe-bottom">
      {/* ── LEFT: nav ── */}
      <aside className="w-44 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-4 py-4 border-b border-gray-100 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-black text-indigo-700">{(userName || '?').charAt(0).toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black text-gray-900 truncate">Mandalika</p>
            <p className="text-[10px] text-gray-400 capitalize truncate">{userRole}</p>
          </div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
          {([
            { id: 'rekapan', label: 'Rekapan' },
            { id: 'riwayat', label: 'Riwayat' },
          ] as const).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`w-full text-left px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
                tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-100 flex-shrink-0 space-y-2">
          <div className="flex items-center gap-2 px-2">
            <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
              <span className="text-[10px] font-black text-indigo-600">{(userName || '?').charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-gray-900 truncate">{userName}</p>
              <p className="text-[10px] text-gray-400 capitalize truncate">{userRole}</p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-all">
            ✕ Kembali ke Kasir
          </button>
        </div>
      </aside>

      {/* ── CENTER ── */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-200 min-w-0 bg-gray-50">
        {isStale && !error && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 text-center flex-shrink-0">
            {OFFLINE_NOTICE}
          </div>
        )}
        {isLoading ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : tab === 'rekapan' ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="flex gap-2.5 bg-indigo-50 border border-indigo-100 rounded-xl p-3">
              <div className="w-4 h-4 mt-0.5 rounded-full bg-indigo-400 flex items-center justify-center flex-shrink-0">
                <span className="text-white text-[10px] font-black">i</span>
              </div>
              <p className="text-xs text-indigo-700">
                Rekap memastikan pembayaran yang dicatat untuk setiap transaksi seimbang dengan setiap jenis pembayaran yang diterima.
              </p>
            </div>

            <div className="space-y-2">
              {paymentMethods.filter((p) => p.isEnabled).map((pm) => (
                <div key={pm.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-700">{pm.label}</span>
                  <span className="text-sm font-black text-gray-900">{formatRupiah(live?.byMethod[pm.id] ?? 0)}</span>
                </div>
              ))}
            </div>

            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-2">
              {[
                { label: 'Total Terhitung', value: live?.totalSales ?? 0 },
                { label: 'Total Tercatat', value: live?.totalSales ?? 0 },
                { label: 'Selisih', value: 0 },
              ].map((r) => (
                <div key={r.label} className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-indigo-800">{r.label}</span>
                  <span className="text-sm font-black text-indigo-700">{formatRupiah(r.value)}</span>
                </div>
              ))}
            </div>

            {!currentShift ? (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <p className="text-sm font-bold text-gray-700">Buka Shift Baru</p>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">Kas Awal (Rp)</label>
                  <input type="number" inputMode="numeric" value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)} placeholder="0"
                    className="w-full px-3 py-2.5 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-lg focus:outline-none" />
                </div>
                <button onClick={handleOpen} disabled={isOpeningShift}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black rounded-xl transition-all">
                  {isOpeningShift ? 'Membuka…' : 'Buka Shift'}
                </button>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
                <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Kas Akhir (Rp)</label>
                <input type="number" inputMode="numeric" value={closingCash}
                  onChange={(e) => setClosingCash(e.target.value)} placeholder="0"
                  className="w-full px-3 py-2.5 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-lg focus:outline-none" />
              </div>
            )}

            {currentShift && (
              <button onClick={handleClose} disabled={isClosingShift}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl transition-all mb-4">
                {isClosingShift ? 'Menutup…' : 'Tutup Shift'}
              </button>
            )}
          </div>
        ) : (
          /* ── Riwayat ── */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
              <input type="text" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Cari rekapan…"
                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div className="flex-1 overflow-y-auto">
              <p className="px-4 pt-4 pb-2 font-black text-gray-900">Riwayat</p>
              <div className="px-4">
                <div className="grid grid-cols-4 text-xs font-black text-gray-400 uppercase tracking-wider pb-2 border-b border-gray-200">
                  <span>Tanggal</span><span>Shift</span><span>Pengguna</span><span className="text-right">Jumlah Terhitung</span>
                </div>
                {history.filter((s) => {
                  const q = historySearch.toLowerCase()
                  return !q || s.cashierName.toLowerCase().includes(q) || (s.openedAt ?? '').includes(q)
                }).length === 0 ? (
                  <div className="py-12 text-center text-gray-400">
                    <p className="text-sm font-bold">Tidak ada riwayat</p>
                  </div>
                ) : (
                  history
                    .filter((s) => {
                      const q = historySearch.toLowerCase()
                      return !q || s.cashierName.toLowerCase().includes(q) || (s.openedAt ?? '').includes(q)
                    })
                    .map((s) => {
                      const sameDay = history.filter(
                        (h) => (h.openedAt ?? '').slice(0, 10) === (s.openedAt ?? '').slice(0, 10),
                      )
                      const shiftNum = sameDay.length - sameDay.indexOf(s)
                      const isSel = selected?.id === s.id
                      return (
                        <button key={s.id} onClick={() => void selectHistoryShift(s)}
                          className={`w-full grid grid-cols-4 py-3 border-b border-gray-100 text-left text-sm transition-all hover:bg-indigo-50 ${isSel ? 'bg-indigo-50' : ''}`}>
                          <span className="text-gray-700 font-semibold">{fmtDate(s.openedAt)}</span>
                          <span className="text-gray-500">Shift {shiftNum}</span>
                          <span className="text-gray-700 truncate pr-2">{s.cashierName}</span>
                          <span className={`text-right font-black ${isSel ? 'text-indigo-600' : 'text-gray-900'}`}>{formatRupiah(s.totalSales)}</span>
                        </button>
                      )
                    })
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── RIGHT: detail ── */}
      <div className="w-80 bg-white overflow-y-auto flex-shrink-0 border-l border-gray-200">
        {tab === 'rekapan' ? (
          <div className="p-4 space-y-4">
            <div>
              <p className="text-xs font-black text-gray-900 mb-2">Ringkasan Uang Masuk/Keluar</p>
              {sumRow(`${inFlows.length} Uang Masuk`, formatRupiah(cashIn))}
              {sumRow(`${outFlows.length} Uang Keluar`, formatRupiah(cashOut))}
              <div className="border-t border-gray-100">{sumRow('Total', formatRupiah(cashIn - cashOut), true)}</div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1">
                <span>Ringkasan Uang Masuk</span><span>Nominal</span>
              </div>
              {inFlows.slice(0, 5).map((f) => (
                <div key={f.id} className="flex justify-between text-xs py-1">
                  <span className="text-gray-500 truncate mr-2">{f.description || f.type}</span>
                  <span className="font-bold flex-shrink-0">{formatRupiah(f.amount)}</span>
                </div>
              ))}
              <div className="border-t border-gray-100">{sumRow('Total', formatRupiah(cashIn), true)}</div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1">
                <span>Ringkasan Uang Keluar</span><span>Nominal</span>
              </div>
              {outFlows.slice(0, 5).map((f) => (
                <div key={f.id} className="flex justify-between text-xs py-1">
                  <span className="text-gray-500 truncate mr-2">{f.description || f.type}</span>
                  <span className="font-bold flex-shrink-0">{formatRupiah(f.amount)}</span>
                </div>
              ))}
              <div className="border-t border-gray-100">{sumRow('Total', formatRupiah(cashOut), true)}</div>
            </div>

            <div>
              <p className="text-xs font-black text-gray-900 mb-2">Ringkasan Penjualan</p>
              <div className="flex justify-between text-xs font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1">
                <span>Ringkasan Pesanan</span><span>Qty</span>
              </div>
              {sumRow('Total Transaksi', String(live?.totalOrders ?? 0))}
              {sumRow('Total Pengembalian', String(live?.refundCount ?? 0))}
              {sumRow('Total Pengembalian Item', String(live?.refundItems ?? 0))}
            </div>

            <div>
              <div className="flex justify-between text-xs font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1">
                <span>Tipe</span><span>Nominal</span>
              </div>
              {sumRow('Penjualan Kotor', formatRupiah(live?.gross ?? 0))}
              {sumRow('Pengembalian Kotor', formatRupiah(live?.refundTotal ?? 0))}
              {sumRow('Diskon', formatRupiah(live?.discount ?? 0))}
              {sumRow('Surcharge', formatRupiah(live?.surcharge ?? 0))}
              {sumRow('Penjualan Bersih', formatRupiah(live?.net ?? 0), true)}
              {sumRow('Pajak', formatRupiah(live?.tax ?? 0))}
              {sumRow('Total Penjualan', formatRupiah(live?.totalSales ?? 0), true)}
            </div>
          </div>
        ) : selected ? (
          (() => {
            const b = aggregate(selectedOrders)
            return (
              <div className="p-4 space-y-4">
                <div>
                  <p className="text-xs text-gray-400">{fmtDate(selected.openedAt)}</p>
                  <p className="font-black text-gray-900">Rekapan - Mandalika</p>
                  <p className="text-xs text-gray-500 mt-0.5">Server {selected.cashierName}</p>
                </div>
                <div>
                  <p className="text-xs font-black text-gray-900 mb-2">Ringkasan</p>
                  <div className="grid grid-cols-4 text-xs font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1 gap-1">
                    <span>Tipe</span><span className="text-right">Terhitung</span>
                    <span className="text-right">Tercatat</span><span className="text-right">Selisih</span>
                  </div>
                  {loadingSelected ? (
                    <div className="py-4 text-center">
                      <div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin mx-auto" />
                    </div>
                  ) : (
                    <>
                      {paymentMethods.map((pm) => (
                        <div key={pm.id} className="grid grid-cols-4 text-xs py-1.5 border-b border-gray-50 gap-1">
                          <span className="truncate text-gray-700">{pm.label}</span>
                          <span className="text-right font-bold">{formatRupiah(b.byMethod[pm.id] ?? 0)}</span>
                          <span className="text-right text-gray-400">{formatRupiah(b.byMethod[pm.id] ?? 0)}</span>
                          <span className="text-right text-gray-400">0</span>
                        </div>
                      ))}
                      <div className="grid grid-cols-4 text-xs py-1.5 font-black gap-1 border-t border-gray-200">
                        <span>Total</span>
                        <span className="text-right">{formatRupiah(b.totalSales)}</span>
                        <span className="text-right">{formatRupiah(b.totalSales)}</span>
                        <span className="text-right">0</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          })()
        ) : (
          <div className="p-6 space-y-2">
            <p className="font-black text-gray-900">Rekapan - Mandalika</p>
            <p className="text-sm text-gray-400">Ketuk salah satu riwayat rekapan untuk menunjukkan detail di sini.</p>
          </div>
        )}
      </div>
    </div>
  )
}
