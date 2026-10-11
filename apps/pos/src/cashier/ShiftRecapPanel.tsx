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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isCashMethod } from '@mandalika/types'
import type { components } from '@mandalika/api'
import type { RecapData } from '@mandalika/printer'
import type { QueuedRefund } from '@mandalika/sync'
import { api } from '../api'
import { usePrinter } from '../printer'
import { formatRupiah } from './pricing'
import { freshCurrentRecap, loadCurrentRecap, loadRecapHistory, loadHistoricalRecap, RECAP_STALE_NOTICE } from './recapData'
import { Skeleton } from '../components/Skeleton'
import { applyRefundRecap, recapFigures, refundRecap, type RefundRecap } from './refundRecap'
import { RecapLoadGate, ownsFlags, startRefresh, switchTab } from './recapRefresh'

type ReceiptSettings = components['schemas']['ReceiptSettings']
type Shift = components['schemas']['Shift']
type CashFlow = components['schemas']['CashFlow']
type Order = components['schemas']['Order']
type PaymentMethodCfg = { id: string; label: string; isEnabled: boolean; isCash?: boolean | null }

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

function aggregate(orders: Order[], methods: PaymentMethodCfg[]): Breakdown {
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
    if (isCashMethod(methods, o.paymentMethod)) b.cashSales += o.total
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
  outletName: string
  closeIntent?: boolean
  receipt: ReceiptSettings
  /** Resolve true once the op is durably queued; false = not saved (inputs are kept). */
  onOpenShift: (startingCash: number) => Promise<boolean>
  onCloseShift: (closingCash: number, countedByMethod?: Record<string, number>) => Promise<boolean>
  /** Persistent error when a shift op could not be stored on the device. */
  shiftError?: string | null
  isOpeningShift: boolean
  isClosingShift: boolean
  /** Refunds on this device not yet acknowledged by the server (incl. parked), from the sync engine. */
  queuedRefunds: readonly QueuedRefund[]
}

const HISTORY_PAGE_SIZE = 20
const REFRESH_MAX_ATTEMPTS = 4
const REFRESH_BASE_MS = 2000

type Tab = 'rekapan' | 'riwayat'

/** Muted notes under the recorded total: refunds this drawer paid for other shifts' sales, refunds
 *  parked for review (not subtracted: the server never counted them) and legacy items without detail. */
function RefundRecapNotes({ rec }: { rec: RefundRecap }) {
  if (rec.crossTotal === 0 && rec.ownPendingTotal === 0 && rec.parkedCount === 0 && rec.unknownDetailCount === 0) return null
  return (
    <div className="space-y-0.5 text-[11px] text-gray-400">
      {rec.crossTotal !== 0 && (
        <div className="flex justify-between"><span>Refund transaksi shift lain</span><span>−{formatRupiah(rec.crossTotal)}</span></div>
      )}
      {rec.ownPendingTotal !== 0 && (
        <div className="flex justify-between"><span>Refund belum tersinkron</span><span>−{formatRupiah(rec.ownPendingTotal)}</span></div>
      )}
      {rec.parkedCount > 0 && (
        <div className="flex justify-between"><span>Refund perlu ditinjau: {rec.parkedCount}</span><span>{formatRupiah(rec.parkedTotal)}</span></div>
      )}
      {rec.unknownDetailCount > 0 && (
        <p>Refund belum tersinkron tanpa detail: {rec.unknownDetailCount} (tidak dihitung)</p>
      )}
    </div>
  )
}

const sumRow = (label: string, value: string, bold = false) => (
    <div className={`flex justify-between text-sm py-1 ${bold ? 'font-black text-gray-900' : ''}`}>
      <span className={bold ? 'text-gray-900' : 'text-gray-500'}>{label}</span>
      <span>{value}</span>
    </div>
  )

export function ShiftRecapPanel(props: ShiftRecapPanelProps) {
  // Mount the panel only while open, so per-shift view state (tab, selected
  // history shift, counts, status messages) resets cleanly on each open —
  // no isOpen-change effects adjusting state from a prop.
  if (!props.isOpen) return null
  return <ShiftRecapPanelBody {...props} />
}

function ShiftRecapPanelBody({
  onClose,
  paymentMethods,
  userName,
  userRole,
  outletName,
  closeIntent,
  receipt,
  onOpenShift,
  onCloseShift,
  shiftError,
  isOpeningShift,
  isClosingShift,
  queuedRefunds,
}: Omit<ShiftRecapPanelProps, 'isOpen'>) {
  const printer = usePrinter()
  const [printMsg, setPrintMsg] = useState<string | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('rekapan')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true when the figures shown were restored from the offline cache.
  const [isStale, setIsStale] = useState(false)

  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [currentFlows, setCurrentFlows] = useState<CashFlow[]>([])
  // Raw orders are kept so a settings change re-aggregates without a reload (which
  // would also wipe the typed 'Terhitung' counts).
  const [liveOrders, setLiveOrders] = useState<Order[] | null>(null)
  const live: Breakdown | null = useMemo(
    () => (liveOrders ? aggregate(liveOrders, paymentMethods) : null),
    [liveOrders, paymentMethods],
  )

  // Recorded cash net of refunds paid out of this drawer: other shifts' sales (server snapshot + queued)
  // and this shift's own sales whose refund has not synced yet.
  const cur = live ? recapFigures(live, currentShift, queuedRefunds, liveOrders) : null
  const curRecap = cur?.rec ?? refundRecap(currentShift, queuedRefunds, liveOrders)

  const [history, setHistory] = useState<Shift[]>([])
  const [historySearch, setHistorySearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [histPage, setHistPage] = useState(1)
  const selectionRequest = useRef(0)
  const [selected, setSelected] = useState<Shift | null>(null)
  const [selectedOrders, setSelectedOrders] = useState<Order[]>([])
  const [selectedFlows, setSelectedFlows] = useState<CashFlow[]>([])
  const [selectedStale, setSelectedStale] = useState(false)
  const [selectedError, setSelectedError] = useState<string | null>(null)
  const [loadingSelected, setLoadingSelected] = useState(false)
  // Portrait: the right detail pane is a full-screen overlay instead of a
  // squished third column. Opened on shift-select (Riwayat) or via a button
  // (Rekapan); ignored on sm+ where the side panel is always shown.
  const [showMobileDetail, setShowMobileDetail] = useState(false)

  const [depositAmount, setDepositAmount] = useState('')
  const [closingCash, setClosingCash] = useState('')
  // Per-method cash the cashier physically counted (reconciliation "Terhitung").
  // Keyed by payment-method id; only filled keys are sent on close.
  const [counted, setCounted] = useState<Record<string, number>>({})

  // Rekapan and Riwayat share the loading/stale/error flags, so each tab has its own ordering gate and
  // only the visible tab may touch the flags. (Ordering rules: RecapLoadGate.)
  const rekapGate = useRef(new RecapLoadGate())
  const histGate = useRef(new RecapLoadGate())
  const tabRef = useRef(tab)
  useEffect(() => { tabRef.current = tab }, [tab])

  const loadRekap = useCallback(async () => {
    const gate = rekapGate.current
    const ticket = gate.begin()
    if (ownsFlags(tabRef.current, 'rekapan')) { // a delayed load while on Riwayat must not touch its flags
      setIsLoading(true)
      setError(null)
    }
    try {
      const { data: { shift, flows, orders }, stale } = await loadCurrentRecap(api)
      // 'Terhitung' is only ever prefilled by the newest load (a refresh does not prefill it), so a late
      // older load cannot wipe counts typed since.
      if (gate.isNewestLoad(ticket)) setCounted((shift?.countedByMethod as Record<string, number> | null | undefined) ?? {})
      if (!gate.canApply(ticket)) return
      const showStale = gate.apply(ticket, stale)
      setCurrentShift(shift)
      setCurrentFlows(flows)
      setLiveOrders(shift ? orders : null)
      if (tabRef.current === 'rekapan') setIsStale(showStale)
    } catch (e: unknown) {
      // Swallowed only when newer data already applied; otherwise the cashier must see the failure.
      if (gate.canApply(ticket) && tabRef.current === 'rekapan') setError(e instanceof Error ? e.message : 'Gagal memuat rekap lengkap')
    } finally {
      if (gate.end(ticket) && ownsFlags(tabRef.current, 'rekapan')) setIsLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async () => {
    const gate = histGate.current
    const ticket = gate.begin()
    if (ownsFlags(tabRef.current, 'riwayat')) {
      setIsLoading(true)
      setError(null)
    }
    try {
      const { data, stale } = await loadRecapHistory(api)
      if (!gate.canApply(ticket)) return
      gate.apply(ticket, stale)
      setHistory(data)
      if (tabRef.current === 'riwayat') setIsStale(stale)
    } catch (e: unknown) {
      if (gate.canApply(ticket) && tabRef.current === 'riwayat') setError(e instanceof Error ? e.message : 'Gagal memuat riwayat shift lengkap')
    } finally {
      if (gate.end(ticket) && ownsFlags(tabRef.current, 'riwayat')) setIsLoading(false)
    }
  }, [])

  // Switching tabs clears the previous tab's transient view state (selected
  // history shift, detail overlay, status messages) before the new tab loads.
  const changeTab = (requested: Tab) => {
    const next = switchTab(tab, requested)
    if (next === null) return // already on this tab: nothing to reset or reload
    tabRef.current = next
    selectionRequest.current++
    setSelected(null)
    setShowMobileDetail(false)
    setPrintMsg(null)
    setCloseError(null)
    // The previous tab's loading/stale/error flags must not leak into the next tab.
    setIsLoading(false)
    setIsStale(false)
    setError(null)
    setTab(next)
  }

  // A refund queued, acknowledged or parked changes what is already out of the server's figures: refetch
  // shift, orders and flows together, WITHOUT touching 'Terhitung' (loadRekap would wipe typed counts).
  // The signature counts as applied only once a refresh succeeded; failures retry with backoff.
  const queueSignature = queuedRefunds.map((r) => `${r.idempotencyKey}:${r.parked ? 'p' : 'q'}`).join('|')
  const appliedQueueSignature = useRef(queueSignature)
  useEffect(() => {
    if (tab !== 'rekapan' || appliedQueueSignature.current === queueSignature) return
    return startRefresh({
      fetch: async () => {
        const ticket = rekapGate.current.issue()
        const data = await freshCurrentRecap(api) // the cached fallback counts as a failure here
        const outcome = rekapGate.current.resolveRefresh(ticket)
        if (outcome === 'retry') throw new Error('superseded by a load that was not fresh')
        return { ticket, outcome, data }
      },
      apply: ({ ticket, outcome, data: { shift, flows, orders } }) => {
        // Re-checked here: a newer load may have applied between the fetch resolving and this callback.
        if (outcome === 'apply' && rekapGate.current.resolveRefresh(ticket) === 'apply') {
          const showStale = rekapGate.current.apply(ticket, false)
          setCurrentShift(shift)
          setCurrentFlows(flows)
          setLiveOrders(shift ? orders : null)
          setIsStale(showStale)
          setError(null)
        } // 'covered': a newer fresh load already applied
        appliedQueueSignature.current = queueSignature
      },
      onGiveUp: () => {
        if (rekapGate.current.giveUp()) setIsStale(true)
      },
      maxAttempts: REFRESH_MAX_ATTEMPTS,
      baseMs: REFRESH_BASE_MS,
    })
  }, [queueSignature, tab])

  // Load the active tab's data on mount (panel open) and on every tab change.
  useEffect(() => {
    if (tab === 'rekapan') void loadRekap()
    else { setHistPage(1); void loadHistory() }
  }, [tab, loadRekap, loadHistory])

  const selectHistoryShift = async (s: Shift) => {
    const request = ++selectionRequest.current
    setSelected(s)
    setShowMobileDetail(true)
    setSelectedOrders([])
    setSelectedFlows([])
    setSelectedStale(false)
    setSelectedError(null)
    setLoadingSelected(true)
    try {
      const { data, stale } = await loadHistoricalRecap(api, s.id)
      if (request !== selectionRequest.current) return
      setSelectedOrders(data.orders)
      setSelectedFlows(data.flows)
      setSelectedStale(stale)
    } catch (e: unknown) {
      if (request !== selectionRequest.current) return
      setSelectedError(e instanceof Error ? e.message : 'Gagal memuat rekap lengkap')
    } finally {
      if (request === selectionRequest.current) setLoadingSelected(false)
    }
  }

  const handleOpen = async () => {
    if (!(await onOpenShift(parseInt(depositAmount, 10) || 0))) return
    setDepositAmount('')
    setTimeout(() => void loadRekap(), 1700)
  }
  const handleClose = async () => {
    // Counted income is mandatory for every enabled method that took money —
    // the cashier must reconcile each tender before the shift can close.
    const needCount = paymentMethods.filter(
      (p) => p.isEnabled && (live?.byMethod[p.id] ?? 0) > 0 && counted[p.id] === undefined,
    )
    if (needCount.length > 0) {
      setCloseError(`Isi Terhitung dulu untuk: ${needCount.map((m) => m.label).join(', ')}`)
      return
    }
    setCloseError(null)
    const saved = await onCloseShift(
      parseInt(closingCash, 10) || 0,
      Object.keys(counted).length ? counted : undefined,
    )
    if (!saved) return // not stored: keep the counted amounts for a retry
    setClosingCash('')
    setTimeout(() => void loadRekap(), 1700)
  }

  const cashIn = currentFlows.filter((f) => !isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  const cashOut = currentFlows.filter((f) => isCashOut(f.type)).reduce((s, f) => s + f.amount, 0)
  const inFlows = currentFlows.filter((f) => !isCashOut(f.type))
  const outFlows = currentFlows.filter((f) => isCashOut(f.type))

  const handlePrintRecap = async (data: RecapData) => {
    setPrintMsg(null)
    try {
      await printer.printRecap(data, receipt)
      setPrintMsg('Rekap tercetak')
    } catch (e: unknown) {
      setPrintMsg(e instanceof Error ? e.message : 'Gagal mencetak')
    }
  }

  // Recap slip for the current (open) shift — live figures + entered counts.
  const buildCurrentRecap = (): RecapData => ({
    title: 'Rekap Shift',
    outletName: currentShift?.outletName ?? outletName,
    cashierName: userName,
    openedAt: currentShift ? new Date(currentShift.openedAt) : null,
    closedAt: currentShift?.closedAt ? new Date(currentShift.closedAt) : null,
    startingCash: currentShift?.startingCash ?? null,
    closingCash: currentShift?.closingCash ?? null,
    methods: paymentMethods.flatMap((pm) =>
      pm.isEnabled ? [{ label: pm.label, recorded: cur?.byMethod[pm.id] ?? 0, counted: counted[pm.id] ?? null }] : [],
    ),
    totalRecorded: cur?.total ?? 0,
    totalCounted: Object.keys(counted).length ? Object.values(counted).reduce((a, b) => a + b, 0) : null,
    cashIn,
    cashOut,
    crossShiftRefunds: curRecap.crossTotal,
    unsyncedRefunds: curRecap.ownPendingTotal,
    unknownRefundDetailCount: curRecap.unknownDetailCount,
    parkedRefundCount: curRecap.parkedCount,
    parkedRefundTotal: curRecap.parkedTotal,
    gross: live?.gross ?? 0,
    refundTotal: live?.refundTotal ?? 0,
    refundCount: live?.refundCount ?? 0,
    discount: live?.discount ?? 0,
    surcharge: live?.surcharge ?? 0,
    net: live?.net ?? 0,
    tax: live?.tax ?? 0,
    totalSales: live?.totalSales ?? 0,
    totalOrders: live?.totalOrders ?? 0,
    generatedAt: new Date(),
  })

  return (
    <div className="fixed inset-0 z-50 bg-gray-50 flex flex-col sm:flex-row overflow-hidden safe-top safe-bottom">
      {/* ── Mobile top bar (replaces the left rail in portrait) ── */}
      <div className="sm:hidden flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 flex-shrink-0" aria-label="Kembali ke Kasir">✕</button>
        <div className="flex-1 flex gap-1 bg-gray-100 rounded-xl p-1">
          {([{ id: 'rekapan', label: 'Rekapan' }, { id: 'riwayat', label: 'Riwayat' }] as const).map((t) => (
            <button type="button" key={t.id} onClick={() => changeTab(t.id)}
              className={`flex-1 py-1.5 rounded-lg text-sm font-bold transition-all ${tab === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-600'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── LEFT: nav (desktop only) ── */}
      <aside className="hidden sm:flex w-44 bg-white border-r border-gray-200 flex-col flex-shrink-0">
        <div className="px-4 py-4 border-b border-gray-100 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-black text-indigo-700">{(userName || '?').charAt(0).toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-black text-gray-900 truncate">{outletName}</p>
            <p className="text-[10px] text-gray-400 capitalize truncate">{userRole}</p>
          </div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
          {([
            { id: 'rekapan', label: 'Rekapan' },
            { id: 'riwayat', label: 'Riwayat' },
          ] as const).map((t) => (
            <button type="button" key={t.id} onClick={() => changeTab(t.id)}
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
          <button type="button" onClick={onClose}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 rounded-xl transition-all">
            ✕ Kembali ke Kasir
          </button>
        </div>
      </aside>

      {/* ── CENTER ── */}
      <div className="flex-1 flex flex-col overflow-hidden sm:border-r border-gray-200 min-w-0 bg-gray-50">
        {isStale && !error && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 text-center flex-shrink-0">
            {RECAP_STALE_NOTICE}
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

            {closeIntent && currentShift && (
              <div className="flex gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3">
                <span className="text-amber-500 text-sm font-black flex-shrink-0">!</span>
                <p className="text-xs text-amber-700">
                  Isi <b>Terhitung</b> (pendapatan dihitung) untuk setiap metode pembayaran, lalu tekan <b>Tutup Shift</b>.
                </p>
              </div>
            )}

            <div className="space-y-2">
              {paymentMethods.flatMap((pm) => {
                if (!pm.isEnabled) return []
                const recorded = cur?.byMethod[pm.id] ?? 0
                const hasC = counted[pm.id] !== undefined
                const diff = (counted[pm.id] ?? 0) - recorded
                return (
                  <div key={pm.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-700">{pm.label}</span>
                      <span className="text-xs text-gray-400">
                        Tercatat <span className="font-bold text-gray-600">{formatRupiah(recorded)}</span>
                      </span>
                    </div>
                    {currentShift && (
                      <>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide flex-shrink-0">Terhitung</span>
                          <input
                            type="number" inputMode="numeric"
                            aria-label="Terhitung"
                            value={hasC ? String(counted[pm.id]) : ''}
                            onChange={(e) => {
                              const v = e.target.value
                              setCounted((prev) => {
                                const next = { ...prev }
                                if (v === '') delete next[pm.id]
                                else next[pm.id] = Math.max(0, Math.round(Number(v) || 0))
                                return next
                              })
                            }}
                            placeholder={String(recorded)}
                            className="flex-1 min-w-0 px-3 py-1.5 bg-gray-50 border border-gray-200 focus:border-indigo-500 rounded-lg text-sm font-bold text-right focus:outline-none"
                          />
                        </div>
                        {hasC && diff !== 0 && (
                          <p className={`mt-1 text-[11px] font-bold text-right ${diff > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                            Selisih {diff > 0 ? '+' : ''}{formatRupiah(diff)}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {(() => {
              const recordedTotal = cur?.total ?? 0
              const hasCounted = Object.keys(counted).length > 0
              const countedTotal = Object.values(counted).reduce((a, b) => a + b, 0)
              const diffTotal = countedTotal - recordedTotal
              const diffCls = !hasCounted || diffTotal === 0
                ? 'text-indigo-700' : diffTotal > 0 ? 'text-amber-600' : 'text-red-600'
              return (
                <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-indigo-800">Total Tercatat</span>
                    <span className="text-sm font-black text-indigo-700">{formatRupiah(recordedTotal)}</span>
                  </div>
                  <RefundRecapNotes rec={curRecap} />
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-indigo-800">Total Terhitung</span>
                    <span className="text-sm font-black text-indigo-700">{hasCounted ? formatRupiah(countedTotal) : '—'}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-indigo-200 pt-2">
                    <span className="text-sm font-semibold text-indigo-800">Selisih</span>
                    <span className={`text-sm font-black ${diffCls}`}>
                      {hasCounted ? `${diffTotal > 0 ? '+' : ''}${formatRupiah(diffTotal)}` : '—'}
                    </span>
                  </div>
                </div>
              )
            })()}

            {!currentShift ? (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <p className="text-sm font-bold text-gray-700">Buka Shift Baru</p>
                <div>
                  <label htmlFor="shift-kas-awal" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1.5">Kas Awal (Rp)</label>
                  <input id="shift-kas-awal" type="number" inputMode="numeric" value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)} placeholder="0"
                    className="w-full px-3 py-2.5 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-lg focus:outline-none" />
                </div>
                {shiftError && (
                  <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{shiftError}</p>
                )}
                <button type="button" onClick={() => void handleOpen()} disabled={isOpeningShift}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black rounded-xl transition-all">
                  {isOpeningShift ? 'Membuka…' : 'Buka Shift'}
                </button>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
                <label htmlFor="shift-kas-akhir" className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Kas Akhir (Rp)</label>
                <input id="shift-kas-akhir" type="number" inputMode="numeric" value={closingCash}
                  onChange={(e) => setClosingCash(e.target.value)} placeholder="0"
                  className="w-full px-3 py-2.5 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-lg focus:outline-none" />
              </div>
            )}

            {currentShift && (
              <div className="space-y-2">
                {closeError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{closeError}</p>
                )}
                {shiftError && (
                  <p role="alert" className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{shiftError}</p>
                )}
                <button type="button" onClick={() => void handleClose()} disabled={isClosingShift}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl transition-all">
                  {isClosingShift ? 'Menutup…' : 'Tutup Shift'}
                </button>
                <button type="button" onClick={() => void handlePrintRecap(buildCurrentRecap())}
                  className="w-full py-2.5 border border-indigo-200 text-indigo-700 font-bold text-sm rounded-xl hover:bg-indigo-50 transition-all flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></svg>
                  Cetak Rekap
                </button>
                {printMsg && (
                  <p className={`text-xs text-center ${printMsg.includes('Gagal') || printMsg.includes('belum') ? 'text-red-600' : 'text-green-600'}`}>{printMsg}</p>
                )}
              </div>
            )}
            {/* Portrait: open the cash-flow / sales summary as an overlay. */}
            <button type="button" onClick={() => setShowMobileDetail(true)}
              className="sm:hidden w-full py-2.5 border border-gray-200 text-gray-600 font-bold text-sm rounded-xl hover:bg-gray-100 transition-all mb-4">
              Lihat Ringkasan
            </button>
          </div>
        ) : (
          /* ── Riwayat ── */
          (() => {
            const q = historySearch.toLowerCase()
            const filtered = history.filter((s) => {
              if (q && !s.cashierName.toLowerCase().includes(q)) return false
              const day = (s.openedAt ?? '').slice(0, 10)
              if (dateFrom && day < dateFrom) return false
              if (dateTo && day > dateTo) return false
              return true
            })
            const totalPages = Math.max(1, Math.ceil(filtered.length / HISTORY_PAGE_SIZE))
            const page = Math.min(histPage, totalPages)
            const paged = filtered.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE)
            const hasFilter = !!(historySearch || dateFrom || dateTo)
            const inputCls = 'flex-1 min-w-0 px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500'
            return (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0 space-y-2">
                  <input type="text" aria-label="Cari nama kasir" value={historySearch}
                    onChange={(e) => { setHistorySearch(e.target.value); setHistPage(1) }}
                    placeholder="Cari nama kasir…"
                    className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <div className="flex items-center gap-2">
                    <input type="date" value={dateFrom} aria-label="Dari tanggal"
                      onChange={(e) => { setDateFrom(e.target.value); setHistPage(1) }} className={inputCls} />
                    <span className="text-xs text-gray-400 flex-shrink-0">s/d</span>
                    <input type="date" value={dateTo} aria-label="Sampai tanggal"
                      onChange={(e) => { setDateTo(e.target.value); setHistPage(1) }} className={inputCls} />
                    {hasFilter && (
                      <button type="button" onClick={() => { setHistorySearch(''); setDateFrom(''); setDateTo(''); setHistPage(1) }}
                        className="text-xs font-bold text-gray-400 hover:text-gray-600 flex-shrink-0 px-1">Reset</button>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <div className="px-4 pt-3">
                    <div className="grid grid-cols-[5.5rem_3.5rem_minmax(0,1fr)_7rem] gap-2 text-xs font-black text-gray-400 uppercase tracking-wider pb-2 border-b border-gray-200">
                      <span>Tanggal</span><span>Shift</span><span>Pengguna</span><span className="text-right">Penjualan</span>
                    </div>
                    {paged.length === 0 ? (
                      <div className="py-12 text-center text-gray-400">
                        <p className="text-sm font-bold">Tidak ada riwayat</p>
                      </div>
                    ) : (
                      paged.map((s) => {
                        const sameDay = history.filter(
                          (h) => (h.openedAt ?? '').slice(0, 10) === (s.openedAt ?? '').slice(0, 10),
                        )
                        const shiftNum = sameDay.length - sameDay.indexOf(s)
                        const isSel = selected?.id === s.id
                        return (
                          <button type="button" key={s.id} onClick={() => void selectHistoryShift(s)}
                            className={`w-full grid grid-cols-[5.5rem_3.5rem_minmax(0,1fr)_7rem] gap-2 py-3 border-b border-gray-100 text-left text-sm transition-all hover:bg-indigo-50 ${isSel ? 'bg-indigo-50' : ''}`}>
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
                {filtered.length > 0 && (
                  <div className="px-4 py-2 border-t border-gray-200 bg-white flex items-center justify-between flex-shrink-0">
                    <span className="text-xs text-gray-500">{filtered.length} shift · Hal {page}/{totalPages}</span>
                    <div className="flex gap-1">
                      <button type="button" disabled={page <= 1} onClick={() => setHistPage(page - 1)}
                        className="px-2.5 py-1 text-sm font-bold rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-100 transition-all">‹</button>
                      <button type="button" disabled={page >= totalPages} onClick={() => setHistPage(page + 1)}
                        className="px-2.5 py-1 text-sm font-bold rounded-lg border border-gray-200 text-gray-600 disabled:opacity-40 hover:bg-gray-100 transition-all">›</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })()
        )}
      </div>

      {/* ── RIGHT: detail (desktop side panel; full-screen overlay in portrait) ── */}
      <div className={`${showMobileDetail ? 'fixed inset-0 z-[60]' : 'hidden'} sm:static sm:z-auto sm:block w-full sm:w-80 bg-white overflow-y-auto flex-shrink-0 border-l border-gray-200 safe-top safe-bottom`}>
        <div className="sm:hidden sticky top-0 z-10 flex items-center gap-2 px-4 py-3 border-b border-gray-200 bg-white">
          <button type="button" onClick={() => setShowMobileDetail(false)} className="text-sm font-bold text-gray-600 hover:text-gray-900">‹ Kembali</button>
          <span className="font-bold text-gray-900">{tab === 'rekapan' ? 'Ringkasan' : 'Detail Rekapan'}</span>
        </div>
        {tab === 'rekapan' && (isLoading || error) ? <p className="p-4 text-sm text-gray-500">{isLoading ? 'Memuat data lengkap…' : 'Rekap lengkap belum tersedia.'}</p> : tab === 'rekapan' ? (
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
            const b = aggregate(selectedOrders, paymentMethods)
            // A closed shift's snapshot is final: only what the server recorded, never the live queue.
            const histRecap = refundRecap(selected, undefined)
            const hist = applyRefundRecap(b.byMethod, b.totalSales, histRecap)
            const countedMap = (selected.countedByMethod ?? {}) as Record<string, number>
            const countedTotal = Object.values(countedMap).reduce((a, n) => a + n, 0)
            const hasCounted = Object.keys(countedMap).length > 0
            const totalDiff = countedTotal - hist.total
            // Products + variants sold this shift (exclude refunded/cancelled).
            const soldMap = new Map<string, { name: string; variant: string; qty: number; amount: number }>()
            for (const o of selectedOrders) {
              if (o.status === 'refunded' || o.status === 'cancelled') continue
              for (const it of o.items) {
                const key = `${it.productName}|${it.variantSize ?? ''}`
                const cur = soldMap.get(key) ?? { name: it.productName, variant: it.variantSize ?? '', qty: 0, amount: 0 }
                cur.qty += it.quantity
                cur.amount += it.subtotal
                soldMap.set(key, cur)
              }
            }
            const sold = [...soldMap.values()].sort((a, c) => c.qty - a.qty)
            const recapData: RecapData = {
              title: 'Rekap Shift',
              outletName: selected.outletName ?? outletName,
              cashierName: selected.cashierName,
              openedAt: new Date(selected.openedAt),
              closedAt: selected.closedAt ? new Date(selected.closedAt) : null,
              startingCash: selected.startingCash,
              closingCash: selected.closingCash ?? null,
              methods: paymentMethods.map((pm) => ({
                label: pm.label,
                recorded: hist.byMethod[pm.id] ?? 0,
                counted: pm.id in countedMap ? countedMap[pm.id] : null,
              })),
              totalRecorded: hist.total,
              totalCounted: hasCounted ? countedTotal : null,
              cashIn: selectedFlows.filter((f) => !isCashOut(f.type)).reduce((sum, f) => sum + f.amount, 0),
              cashOut: selectedFlows.filter((f) => isCashOut(f.type)).reduce((sum, f) => sum + f.amount, 0),
              crossShiftRefunds: histRecap.crossTotal,
              gross: b.gross,
              refundTotal: b.refundTotal,
              refundCount: b.refundCount,
              discount: b.discount,
              surcharge: b.surcharge,
              net: b.net,
              tax: b.tax,
              totalSales: b.totalSales,
              totalOrders: b.totalOrders,
              generatedAt: new Date(),
            }
            return (
              <div className="p-4 space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">{fmtDate(selected.openedAt)}</p>
                    <p className="font-black text-gray-900">Rekapan - {outletName}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{selected.cashierName}</p>
                  </div>
                  {!loadingSelected && !selectedError && (
                    <button type="button" onClick={() => void handlePrintRecap(recapData)} title="Cetak Rekap"
                      className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-indigo-200 text-indigo-700 text-xs font-bold hover:bg-indigo-50 transition-all">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></svg>
                      Cetak
                    </button>
                  )}
                </div>
                {printMsg && (
                  <p className={`text-xs ${printMsg.includes('Gagal') || printMsg.includes('belum') ? 'text-red-600' : 'text-green-600'}`}>{printMsg}</p>
                )}

                {selectedStale && <p role="status" className="text-xs text-amber-700">{RECAP_STALE_NOTICE}</p>}
                {selectedError ? <p role="alert" className="text-sm text-red-600">{selectedError}</p> : loadingSelected ? (
                  <div className="py-4 text-center">
                    <div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin mx-auto" />
                  </div>
                ) : (
                  <>
                    {/* Reconciliation — stacked per method so large amounts never overlap. */}
                    <div>
                      <p className="text-xs font-black text-gray-900 mb-2">Ringkasan Pembayaran</p>
                      <div className="space-y-2">
                        {paymentMethods.map((pm) => {
                          const recorded = hist.byMethod[pm.id] ?? 0
                          const hasC = pm.id in countedMap
                          const c = countedMap[pm.id] ?? 0
                          const diff = c - recorded
                          if (recorded === 0 && !hasC) return null
                          return (
                            <div key={pm.id} className="border border-gray-100 rounded-lg px-3 py-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-gray-700">{pm.label}</span>
                                {hasC && (
                                  <span className={`text-[11px] font-bold ${diff === 0 ? 'text-gray-400' : diff > 0 ? 'text-amber-600' : 'text-red-600'}`}>
                                    {diff > 0 ? '+' : ''}{formatRupiah(diff)}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center justify-between text-[11px] mt-1">
                                <span className="text-gray-400">Tercatat</span>
                                <span className="font-semibold text-gray-600">{formatRupiah(recorded)}</span>
                              </div>
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-gray-400">Terhitung</span>
                                <span className="font-semibold text-gray-600">{hasC ? formatRupiah(c) : '—'}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">
                        <div className="flex justify-between text-xs font-black text-gray-900">
                          <span>Total Tercatat</span><span>{formatRupiah(hist.total)}</span>
                        </div>
                        <RefundRecapNotes rec={histRecap} />
                        {hasCounted && (
                          <>
                            <div className="flex justify-between text-xs font-bold text-gray-600">
                              <span>Total Terhitung</span><span>{formatRupiah(countedTotal)}</span>
                            </div>
                            <div className="flex justify-between text-xs font-bold">
                              <span className="text-gray-600">Selisih</span>
                              <span className={totalDiff === 0 ? 'text-gray-400' : totalDiff > 0 ? 'text-amber-600' : 'text-red-600'}>
                                {totalDiff > 0 ? '+' : ''}{formatRupiah(totalDiff)}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <div>
                      {sumRow('Kas Masuk', formatRupiah(recapData.cashIn ?? 0))}
                      {sumRow('Kas Keluar', formatRupiah(recapData.cashOut ?? 0))}
                    </div>
                    {/* Products + variants sold this shift. */}
                    <div>
                      <p className="text-xs font-black text-gray-900 mb-2">Produk Terjual</p>
                      {sold.length === 0 ? (
                        <p className="text-xs text-gray-400">Tidak ada penjualan.</p>
                      ) : (
                        <>
                          <div className="flex justify-between text-[10px] font-black text-gray-400 uppercase tracking-wider border-b border-gray-200 pb-1 mb-1">
                            <span>Produk</span><span>Qty · Subtotal</span>
                          </div>
                          {sold.map((p) => (
                            <div key={`${p.name}|${p.variant}`} className="flex justify-between gap-2 py-1.5 border-b border-gray-50">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-gray-700 truncate">{p.name}</p>
                                {p.variant && <p className="text-[10px] text-gray-400">{p.variant}</p>}
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="text-xs font-bold text-gray-800">×{p.qty}</p>
                                <p className="text-[10px] text-gray-400">{formatRupiah(p.amount)}</p>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })()
        ) : (
          <div className="p-6 space-y-2">
            <p className="font-black text-gray-900">Rekapan - {outletName}</p>
            <p className="text-sm text-gray-400">Ketuk salah satu riwayat rekapan untuk menunjukkan detail di sini.</p>
          </div>
        )}
      </div>
    </div>
  )
}
