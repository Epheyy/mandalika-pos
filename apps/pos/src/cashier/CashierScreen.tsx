/**
 * Orchestrator — no business logic, composes leaf components.
 * Data from SyncEngine snapshot (offline-first); writes via engine.enqueue.
 */

import { use, useReducer, useRef, useState, useEffect, useMemo } from 'react'
import type { components } from '@mandalika/api'
import { normalizePhone, type LocalReceipt } from '@mandalika/sync'
import { canRefund, isCashMethod, variantLabel } from '@mandalika/types'
import type { ReceiptData } from '@mandalika/printer'
import { SyncContext, SyncReceiveRejectedRefContext, SyncReceiveAcceptedRefContext } from './SyncProvider'
import { useAutoPullGate } from './autoPullGate'
import { TandaTerimaPrompt } from './transfers/TandaTerimaPrompt'
import { buildTandaTerimaData } from './transfers/buildTandaTerimaData'
import { TransferHistoryPanel } from './TransferHistoryPanel'
import { usePrinter } from '../printer'
import { setBackHandler } from '../native'
import { useAuth } from '../auth'
import { useOfflineData } from '../hooks/useOfflineData'
import { useOfflineCap } from '../hooks/useOfflineCap'
import { offlineLockMessage } from '../lib/offlineCap'
import { useShift } from '../hooks/useShift'
import { useTerminalLabel } from '../hooks/useTerminalLabel'
import { useCart } from '../hooks/useCart'
import { cashierReducer, CASHIER_INITIAL_STATE } from './state/cashierReducer'
import { ProductGrid } from './ProductGrid'
import { buildScanIndex, resolveScan } from './scan'
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning'
import { Cart } from './Cart'
import { CheckoutPanel } from './CheckoutPanel'
import { cashTender } from './tender'
import { CustomerPicker } from './CustomerPicker'
import { awaitingSearch, finderHits, getKnownCustomers, lookupFailureMessage, prefillFromSearch } from './customerFinder'
import { AdjustmentDrawer } from './AdjustmentDrawer'
import { MenuDrawer } from './MenuDrawer'
import { ReceiveTransferPanel } from './receive/ReceiveTransferPanel'
import { ReceiveApprovalModal } from './receive/ReceiveApprovalModal'
import { ShiftBar } from './ShiftBar'
import { ReceiptPreview } from './ReceiptPreview'
import { RefundDialog } from './RefundDialog'
import { REFUND_DONE, REFUND_QUEUED, planRefundSubmit, refundGateProps, type LocalSaleRef } from './refundView'
import { OrderHistoryPanel } from './OrderHistoryPanel'
import { LocalReceiptsPanel } from './LocalReceiptsPanel'
import { localReceiptOrder, localSaleRef, newestReprintable, reprintReceiptData } from './localReceipts'
import { ShiftRecapPanel } from './ShiftRecapPanel'
import { SyncStatus } from '../components/SyncStatus'
import { SettingsScreen, type SettingsSection } from '../screens/SettingsScreen'
import { reserveOrderNo } from './orderRef'
import { effectivePromotionSelection, isRedundantPromoCode } from './promotionSelection'
import { buildPromotionMetadata } from './promotionMetadata'
import { buildReceiptQuote, receiptFromQuote, type ReceiptQuote } from './receiptQuote'
import { applyPendingStock, stockFor, oversoldSizes, OVERSELL_WARNING } from './stock'
import { decideApplyCode, validatePromo, validateCode, violationMessage } from './promoValidate'
import { calcPromoDiscount, bxgyRewardDue } from './pricing'
import { planPromotionFulfillment, invalidPhysicalPromotionIds, type PromotionOwner, type FulfillmentPlan } from './promotionFulfillment'
import { BxgyRewardModal, type BxgyRewardPick } from './BxgyRewardModal'
import { BundleSlotPicker } from './BundleSlotPicker'
import type { BundleAssignment } from './bundle'
import { api, authStore } from '../api'
import { reportErrors } from '../lib/errorReporter'
import { diagnosticExportMessages, shareFailedSyncDiagnostics } from '../lib/failedSyncDiagnostics'
import { track } from '../lib/activityLog'
import { createSubmitGate, notSavedMessage } from '../lib/durableSubmit'
import logoGold from '../assets/logo-gold.png'

type FontSize = 'sm' | 'md' | 'lg'
type GridCols = 2 | 3 | 4 | 6
type Order = components['schemas']['Order']
type Customer = components['schemas']['Customer']
type Transfer = components['schemas']['Transfer']

const DEFAULT_SETTINGS: components['schemas']['AppSettings'] = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none',
  paymentMethods: [
    { id: 'cash', label: 'Tunai', isEnabled: true },
    { id: 'card', label: 'Kartu', isEnabled: true },
    { id: 'qris', label: 'QRIS', isEnabled: true },
    { id: 'transfer', label: 'Transfer', isEnabled: true },
  ],
  receipt: { headerText: '', footerText: '', showTax: true, showCashier: true },
  autoOpenShift: false,
  allowNegativeStock: true,
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS',
}

const DEFAULT_LOYALTY: components['schemas']['LoyaltySettings'] = {
  enabled: true, tierEnabled: true, pointsPerThousand: 1, redemptionRate: 100,
}

export default function CashierScreen() {
  const { user } = useAuth()
  const engine = use(SyncContext)!
  const receiveRejectedRef = use(SyncReceiveRejectedRefContext)
  const receiveAcceptedRef = use(SyncReceiveAcceptedRefContext)
  const [pendingTT, setPendingTT] = useState<Transfer | null>(null)
  // Track recently-received transfers so the receive panel can offer reprint.
  const [completedTransfers, setCompletedTransfers] = useState<Transfer[]>([])
  const offlineData = useOfflineData()
  const shift = useShift()
  const outletLabel = useTerminalLabel()
  const [state, dispatch] = useReducer(cashierReducer, CASHIER_INITIAL_STATE)

  // UI prefs. The layout is a single adaptive view (responsive by width); the
  // old products/cart "default view" and forced-mobile toggles were removed.
  const [fontSize, setFontSize] = useState<FontSize>(
    () => (localStorage.getItem('pos_fontSize') as FontSize | null) ?? 'md',
  )
  const [gridCols, setGridCols] = useState<GridCols>(() => {
    const gc = localStorage.getItem('pos_gridCols')
    return gc ? (parseInt(gc) as GridCols) : 4
  })
  // Optional product-card details — off by default, toggled in display settings.
  const [showPrice, setShowPrice] = useState(() => localStorage.getItem('pos_cardPrice') === '1')
  const [showStock, setShowStock] = useState(() => localStorage.getItem('pos_cardStock') === '1')
  const [showVariants, setShowVariants] = useState(() => localStorage.getItem('pos_cardVariants') === '1')
  const [showSettings, setShowSettings] = useState(false)
  // Which settings section to scroll to when opened from a drawer shortcut.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddingCustomer, setIsAddingCustomer] = useState(false)
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', phone: '', email: '' })
  const [localCustomers, setLocalCustomers] = useState<Customer[]>([])
  // A30: customers are found by full phone number only. The online lookup runs only when the
  // cashier asks (Cari / Enter), never while typing, so it cannot drain the shared per-account
  // budget. Offline (or on a failure) the tablet memory and "add new" still work.
  const [lookupResults, setLookupResults] = useState<Customer[]>([])
  const [lookupPending, setLookupPending] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookupRequest, setLookupRequest] = useState<{ text: string; n: number } | null>(null)
  const searchPhone = normalizePhone(state.customerSearch)
  useEffect(() => {
    setLookupError(null)
    if (!lookupRequest || !offlineData.isOnline || !normalizePhone(lookupRequest.text)) {
      setLookupResults([])
      setLookupPending(false)
      return
    }
    let ignore = false
    setLookupPending(true)
    void (async () => {
      try {
        const res = await api.lookupCustomerByPhone(lookupRequest.text)
        if (ignore) return
        res.forEach((c) => getKnownCustomers().refresh(c))
        setLookupResults(res)
      } catch (e) {
        if (ignore) return
        setLookupResults([])
        setLookupError(lookupFailureMessage(e))
      } finally {
        if (!ignore) setLookupPending(false)
      }
    })()
    return () => {
      ignore = true
    }
  }, [lookupRequest, offlineData.isOnline])
  // Single-flight gates for actions that mean "durably queued on this device".
  // A ref flips synchronously, unlike the isProcessing/disabled render state.
  const saleGate = useRef(createSubmitGate())
  const refundGate = useRef(createSubmitGate())
  const customerGate = useRef(createSubmitGate())
  const receiveGate = useRef(createSubmitGate())
  const [saleError, setSaleError] = useState<string | null>(null)
  const [refundError, setRefundError] = useState<string | null>(null)
  const [isSavingCustomer, setIsSavingCustomer] = useState(false)
  const [customerError, setCustomerError] = useState<string | null>(null)
  const [isValidatingCode, setIsValidatingCode] = useState(false)
  const [promoCodeError, setPromoCodeError] = useState<string | null>(null)
  // Clear any stale promo-code error once the promo panel is no longer open
  // (covers ×/backdrop close and reducer-driven closes like applying a promo).
  useEffect(() => {
    if (state.activeAdjustment !== 'promo') setPromoCodeError(null)
  }, [state.activeAdjustment])
  const [refundOrder, setRefundOrder] = useState<Order | null>(null)
  const [isRefunding, setIsRefunding] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showLocalReceipts, setShowLocalReceipts] = useState(false)
  // Set while the refund dialog is open for a sale made on this tablet (a local receipt): its identity rides into the payload.
  const [refundSale, setRefundSale] = useState<LocalSaleRef | null>(null)
  const [showRecap, setShowRecap] = useState(false)
  // Raised when the recap was opened to close the shift (header "Tutup") — the
  // panel then requires counted income before allowing the close.
  const [closeIntent, setCloseIntent] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [showTransferHistory, setShowTransferHistory] = useState(false)
  const [pendingReceive, setPendingReceive] = useState<null | { transferId: string; items: { productId: string; variantSize: string; receivedQty: number }[]; reason: string; orderUuid: string; receiptKey: string }>(null)
  // Raised when the cashier tries to sell with no open shift → forces the
  // ShiftBar open-shift modal (selling without a shift is not allowed).
  const [shiftPrompt, setShiftPrompt] = useState(false)
  const printer = usePrinter()
  const lastReceipt = useRef<ReceiptData | null>(null)
  const [printError, setPrintError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // Register the receive-reject notice callback via the ref exposed by
  // SyncProvider so dead-lettered transfer_receive items surface a toast.
  useEffect(() => {
    if (!receiveRejectedRef) return
    receiveRejectedRef.current = (msg: string) => showToast(msg)
    return () => { receiveRejectedRef.current = undefined }
  // showToast is stable (defined in render body but stable via setToast/setTimeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiveRejectedRef])

  // Register the receive-accepted callback so the TandaTerimaPrompt is shown
  // automatically whenever a transfer_receive ack is processed by the engine.
  // Also push to completedTransfers so the reprint button in ReceiveTransferPanel
  // can surface the same slip after the prompt is dismissed.
  useEffect(() => {
    if (!receiveAcceptedRef) return
    receiveAcceptedRef.current = (t: Transfer) => {
      setPendingTT(t)
      setCompletedTransfers((prev) => {
        // Keep last 10 to avoid unbounded growth.
        const next = [t, ...prev.filter((x) => x.id !== t.id)]
        return next.slice(0, 10)
      })
    }
    return () => { receiveAcceptedRef.current = undefined }
  }, [receiveAcceptedRef])

  const snapshot = engine.getSnapshot()
  const inbound = engine.getInboundTransfers()
  const products = (snapshot.products ?? []).filter((p) => p.isActive)
  const pendingStockDeltas = engine.pendingStockDeltas()
  const displayProducts = useMemo(
    () => applyPendingStock(products, pendingStockDeltas),
    [products, pendingStockDeltas],
  )
  const scanIndex = useMemo(() => buildScanIndex(products), [products])
  const categories = snapshot.categories ?? []
  // A30: offered customers are exactly those matching the typed phone: online hits, customers
  // created this session, and the tablet memory (so a known customer still sells offline).
  const customers: Customer[] = finderHits(
    state.customerSearch,
    searchPhone ? getKnownCustomers().findByPhone(state.customerSearch) : [],
    lookupResults,
    localCustomers,
  )
  const salesmen = (snapshot.users ?? []).map((u) => ({ id: u.id, name: u.displayName }))
  const promotions = snapshot.promotions ?? []
  const discountCodes = snapshot.discountCodes ?? []
  const outletTimezone = snapshot.outletTimezone // A28: promo clock = outlet-local; absent (old server) = WIB in promoValidate
  const settings = snapshot.appSettings ?? DEFAULT_SETTINGS
  const loyalty = snapshot.loyaltySettings ?? DEFAULT_LOYALTY

  const { actions: cartActions, derived } = useCart({ state, dispatch, settings, loyalty })

  // Cart panel hides when empty; if the mobile cart tab was active when the
  // last item left, fall back to products so the screen is never blank.
  useEffect(() => {
    if (derived.totalCartItems === 0 && state.activeTab === 'cart') {
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'products' })
    }
  }, [derived.totalCartItems, state.activeTab])

  const [rewards, setRewards] = useState<
    components['schemas']['LoyaltyPreviewReward'][]
  >([])
  const [rewardsLoading, setRewardsLoading] = useState(false)

  // Pending picker context has no effect on the sale until confirmed.
  const [pendingFulfillment, setPendingFulfillment] = useState<(Extract<FulfillmentPlan, { kind: 'bxgy-picker' | 'bundle-picker' }> & { products: components['schemas']['Product'][] }) | null>(null)
  // Background reference pull (auto-pull): the engine may swap the catalog only while nothing is in flight.
  useAutoPullGate(engine, {
    cartCount: state.cart.length, isCheckoutOpen: state.isCheckoutOpen, isProcessing: state.isProcessing,
    isSuccessOpen: state.isSuccessOpen, hasRefundOrder: !!refundOrder, hasRefundSale: !!refundSale, isRefunding,
    showReceive, hasPendingReceive: !!pendingReceive, hasPendingTT: !!pendingTT, hasPendingFulfillment: !!pendingFulfillment,
    isAddingCustomer, isSavingCustomer, hasActiveAdjustment: !!state.activeAdjustment, showHistory, showLocalReceipts,
    showRecap, showTransferHistory, showSettings, showMenu, shiftPrompt, closeIntent,
    hasSelectedCustomer: !!state.selectedCustomer, hasSelectedSalesman: !!state.selectedSalesman,
    appliedPromotionCount: state.appliedPromotions.length, appliedPromoCodeCount: state.appliedPromoCodes.length,
    pointsToRedeem: state.pointsToRedeem,
  })

  useEffect(() => {
    if (
      !state.isCheckoutOpen ||
      !loyalty.enabled ||
      !state.selectedCustomer ||
      !offlineData.isOnline
    ) {
      setRewards([])
      setRewardsLoading(false)
      return
    }
    let ignore = false
    setRewardsLoading(true)
    api
      .loyaltyPreview(state.selectedCustomer.id, state.cart, derived.total)
      .then((r) => {
        if (!ignore) setRewards(r)
      })
      .catch(() => {
        if (!ignore) setRewards([])
      })
      .finally(() => {
        if (!ignore) setRewardsLoading(false)
      })
    return () => {
      ignore = true
    }
    // Fetch once when the panel opens; the cart is final at checkout. Re-picking a
    // reward must not refetch, so cart/derived.total are intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  }, [state.isCheckoutOpen, loyalty.enabled, state.selectedCustomer?.id, offlineData.isOnline])

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const defaultMethod = enabledMethods[0]?.id ?? 'cash'
  const tender = cashTender(isCashMethod(settings.paymentMethods, state.paymentMethod), state.amountPaid, derived.total)

  // A shift must be open before anything can be sold. Returns false (and
  // pops the open-shift modal) when there is no active shift.
  const ensureShift = (): boolean => {
    if (shift.currentShift) return true
    setShiftPrompt(true)
    return false
  }

  // A05: past 12 h without an online contact, new sales/refunds are locked until the tablet
  // reconnects. Evaluated at action time (never cached) and the engine itself never refuses.
  const offlineCap = useOfflineCap(engine)
  const offlineLock = (): string | null => offlineLockMessage(engine.offlineState())

  // A44 owner decision 2026-10-16: an out-of-stock item is never blocked. The line is
  // added and the cashier is warned; the server records the oversell. Returns true when
  // the add passes the (pending-adjusted) stock so scan can pick the right toast.
  const addWithStockWarning = (
    product: components['schemas']['Product'],
    variantQtys: Record<string, number>,
  ): boolean => {
    if (!ensureShift()) return false
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      showToast(lockedMsg)
      return false
    }
    track(`Tambah ${product.name}`)
    const inCart = (size: string) => state.cart
      .filter((i) => i.productId === product.id && i.variantSize === size)
      .reduce((s, i) => s + i.quantity, 0)
    const oversold = oversoldSizes(product, variantQtys, inCart).length > 0
    cartActions.addVariants(product, variantQtys)
    return oversold
  }

  const handleProductTap = (
    product: components['schemas']['Product'],
    variantQtys: Record<string, number>,
  ) => {
    if (addWithStockWarning(product, variantQtys)) showToast(OVERSELL_WARNING)
  }

  // Scan-to-cart: resolve the code to a variant, add 1 respecting stock.
  // Shared by the keyboard-wedge (search Enter) and camera paths.
  const handleScan = (code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    const match = resolveScan(scanIndex, trimmed)
    if (!match) {
      showToast('Kode tidak dikenal')
      return
    }
    const { product, variant } = match
    // Past the stock: still added (A44 owner decision 2026-10-16), with a warning toast.
    const oversold = addWithStockWarning(product, { [variant.size]: 1 })
    showToast(oversold
      ? OVERSELL_WARNING
      : `Ditambah: ${product.name}${variantLabel(variant.size) ? ' ' + variantLabel(variant.size) : ''}`)
  }

  // Wedge path: Enter in the search box. If it exactly matches a barcode, scan
  // and clear the box; otherwise leave it as a normal name filter.
  const handleSearchSubmit = (q: string) => {
    if (resolveScan(scanIndex, q)) {
      handleScan(q)
      setSearchQuery('')
    }
  }

  // Camera path: ML Kit modal scanner (QR + common 1D). Falls back gracefully
  // when unsupported or permission denied — the wedge path still works.
  const handleCameraScan = async () => {
    try {
      const { supported } = await BarcodeScanner.isSupported()
      if (!supported) { showToast('Kamera scan tidak didukung perangkat ini'); return }
      const perm = await BarcodeScanner.requestPermissions()
      if (perm.camera !== 'granted' && perm.camera !== 'limited') {
        showToast('Izin kamera ditolak'); return
      }
      const { barcodes } = await BarcodeScanner.scan({
        formats: [
          BarcodeFormat.QrCode, BarcodeFormat.Ean13, BarcodeFormat.Ean8,
          BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Code128,
          BarcodeFormat.Code39, BarcodeFormat.DataMatrix,
        ],
      })
      const value = barcodes[0]?.rawValue
      if (value) handleScan(value)
    } catch {
      // user cancelled or scanner error — no-op (wedge path remains)
    }
  }

  const handleCheckout = () => {
    // Non-blocking sync: a pending backoffice update never blocks a sale —
    // the order queues and flushes; the SyncStatus chip nudges the cashier.
    if (!ensureShift()) return
    if (state.cart.length === 0) return
    dispatch({ type: 'OPEN_CHECKOUT', defaultMethod })
  }

  const pickedRewards = useMemo(() => {
    const m: Record<string, { productId: string; variantSize: string }> = {}
    for (const c of state.cart) {
      if (c.isReward && c.rewardConditionId) {
        m[c.rewardConditionId] = { productId: c.productId, variantSize: c.variantSize }
      }
    }
    return m
  }, [state.cart])

  const handlePickReward = (
    conditionId: string,
    product: { id: string; name: string },
    variant: { size: string; price: number },
  ) => {
    if (!state.selectedCustomer || !loyalty.enabled || !offlineData.isOnline) return
    dispatch({
      type: 'CART_ADD_REWARD',
      item: {
        productId: product.id,
        productName: product.name,
        variantSize: variant.size,
        price: 0,
        quantity: 1,
        subtotal: 0,
        isReward: true,
        rewardConditionId: conditionId,
      },
    })
  }

  const handleClearReward = (conditionId: string) =>
    dispatch({ type: 'CART_REMOVE_REWARD', rewardConditionId: conditionId })

  // Direct and linked selections share one planning/commit path. The reducer
  // repeats planning against current state so picker confirmation is atomic.
  const applySelection = (owner: PromotionOwner) => {
    const plan = planPromotionFulfillment(state, owner, displayProducts)
    if (plan.kind === 'toggle') dispatch({ type: 'APPLY_PROMOTION', promotion: plan.promotion })
    else if (plan.kind === 'simple') {
      if (owner.kind === 'direct') dispatch({ type: 'APPLY_PROMOTION', promotion: owner.promotion })
      else dispatch({ type: 'APPLY_PROMO_CODE', code: owner.code, combinable: !!owner.code.combinable })
    } else if (plan.kind === 'ready') dispatch({ type: 'APPLY_FULFILLMENT', owner, products: displayProducts })
    else if (plan.kind === 'bxgy-picker' || plan.kind === 'bundle-picker') {
      setPendingFulfillment({ ...plan, products: displayProducts })
    } else if (owner.kind === 'code') showToast('Syarat promo belum terpenuhi')
  }

  const handleSelectPromotion = (promotion: components['schemas']['Promotion']) => applySelection({ kind: 'direct', promotion })

  const handleBxgyRewardConfirm = (picks: BxgyRewardPick[]) => {
    if (pendingFulfillment?.kind !== 'bxgy-picker') return
    dispatch({ type: 'APPLY_FULFILLMENT', owner: pendingFulfillment.owner, products: pendingFulfillment.products, choice: { kind: 'bxgy', picks } })
    setPendingFulfillment(null)
  }

  const handleBundlePickerConfirm = (assignment: BundleAssignment) => {
    if (pendingFulfillment?.kind !== 'bundle-picker') return
    dispatch({ type: 'APPLY_FULFILLMENT', owner: pendingFulfillment.owner, products: pendingFulfillment.products, choice: { kind: 'bundle', assignment } })
    setPendingFulfillment(null)
  }

  // Whole-owner cleanup: a removed physical effect must not leave a used code.
  useEffect(() => {
    for (const id of invalidPhysicalPromotionIds(state)) dispatch({ type: 'REMOVE_PROMOTION', id })
  }, [state.cart, state.appliedPromotions, state.appliedPromoCodes, state.bundleFreed, state.bundleApplications])

  const handleAddCustomer = async () => {
    if (customerGate.current.isBusy()) return
    if (!newCustomerForm.name.trim() || !newCustomerForm.phone.trim()) {
      setCustomerError('Nama dan telepon wajib diisi')
      return
    }
    setIsSavingCustomer(true)
    setCustomerError(null)
    const name = newCustomerForm.name.trim()
    const phone = newCustomerForm.phone.trim()
    const email = newCustomerForm.email.trim()
    // Offline-first: generate the customer UUID on-device and queue a
    // `customer_create` op (works with no connection). The queued op flushes
    // before the sale (FIFO outbox) so the order's customerId resolves
    // server-side. Optimistically add + select so it's usable immediately.
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const outcome = await customerGate.current.run(
      () => engine.enqueue('customer_create', { customerId: id, name, phone, email }, id),
    )
    if (outcome.status === 'busy') return
    setIsSavingCustomer(false)
    if (outcome.status === 'failed') {
      // Nothing was queued: keep the form so the cashier can retry.
      setCustomerError(notSavedMessage('Pelanggan'))
      return
    }
    const created: components['schemas']['Customer'] = {
      id,
      name,
      phone,
      email: email || null,
      points: 0,
      totalSpent: 0,
      visitCount: 0,
      createdAt: new Date().toISOString(),
    }
    setLocalCustomers((prev) => [created, ...prev])
    getKnownCustomers().remember(created)
    dispatch({ type: 'SET_CUSTOMER', customer: created })
    setIsAddingCustomer(false)
    setNewCustomerForm({ name: '', phone: '', email: '' })
  }

  // Search → add-new: the typed phone prefills the form (never a name). Switches the picker
  // into add mode.
  const handleAddNewFromSearch = (q: string) => {
    setNewCustomerForm(prefillFromSearch(q))
    setCustomerError(null)
    setIsAddingCustomer(true)
    dispatch({ type: 'SET_CUSTOMER_SEARCH', search: '' })
  }

  const handleApplyPromoCode = async () => {
    const code = state.promoCodeInput.trim().toUpperCase()
    if (!code) return
    setIsValidatingCode(true)
    try {
      const decision = decideApplyCode(
        code,
        discountCodes,
        {
          now: new Date(),
          outletId: authStore.outletId ?? '',
          timezone: outletTimezone,
          subtotal: derived.subtotal,
          hasCustomer: state.selectedCustomer !== null,
          customerId: state.selectedCustomer?.id,
        },
        promotions,
      )
      if (!decision.ok) {
        setPromoCodeError(decision.reason)
        return
      }
      setPromoCodeError(null)
      if (isRedundantPromoCode(state.appliedPromotions, state.appliedPromoCodes, decision.code)) {
        showToast('Promo sudah aktif')
        dispatch({ type: 'APPLY_PROMO_CODE', code: decision.code, combinable: !!decision.code.combinable })
        return
      }
      applySelection({ kind: 'code', code: decision.code })
    } finally {
      setIsValidatingCode(false)
    }
  }

  const handleConfirmPayment = async () => {
    if (state.isProcessing || saleGate.current.isBusy()) return
    // A cart built at 11h59 can be confirmed at 12h01: the lock is checked at confirm too.
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      showToast(lockedMsg)
      return
    }
    // Re-confirm a clean total if a stale customer benefit survives a UI transition.
    if (!state.selectedCustomer && (state.pointsToRedeem > 0 || state.cart.some(c => c.isReward && c.rewardConditionId))) {
      dispatch({ type: 'SET_CUSTOMER', customer: null })
      showToast('Manfaat loyalti dibatalkan: pilih pelanggan terlebih dahulu')
      return
    }
    const invalidPhysical = invalidPhysicalPromotionIds(state)
    if (invalidPhysical.length) {
      for (const id of invalidPhysical) dispatch({ type: 'REMOVE_PROMOTION', id })
      showToast('Promo dibatalkan: syarat barang berubah')
      return
    }
    const { appliedPromotions, appliedPromoCodes } = effectivePromotionSelection(state.appliedPromotions, state.appliedPromoCodes)
    // Re-guard: a promo/code valid when picked can lapse while the cart sits open
    // (hour/day boundary) or fall below min_purchase (items removed). Block + clear
    // the offending discount so the cashier re-confirms a clean total. This keeps
    // the server-side discount_warning flag a true rarity.
    const guardCtx = {
      now: new Date(),
      outletId: authStore.outletId ?? '',
      timezone: outletTimezone,
      subtotal: derived.subtotal,
      hasCustomer: state.selectedCustomer !== null,
      customerId: state.selectedCustomer?.id,
    }
    for (const p of appliedPromotions) {
      const vs = validatePromo(p, guardCtx)
      if (vs.length > 0) {
        showToast(`Promo dibatalkan: ${violationMessage(vs[0])}`)
        dispatch({ type: 'CLEAR_PROMOTIONS' })
        return
      }
      // buy_x_get_y has a cart precondition that gating can't see: if the cart
      // no longer satisfies the buy/get criteria (items removed after applying),
      // drop it so it isn't recorded as applied in history. SEPARATE-SET earns a
      // reward (calcPromoDiscount is always 0), so check bxgyRewardDue over PAID
      // lines and also strip the reward lines so they don't linger. SAME-SET
      // discounts in place → check the discount.
      if (p.type === 'buy_x_get_y') {
        const cfg = p.bxgyConfig
        const isSeparateSet = (cfg?.getProductIds ?? []).length > 0
        const unmet = isSeparateSet
          ? bxgyRewardDue(cfg, state.cart.filter((c) => !c.isReward)) < 1
          : calcPromoDiscount(p, state.cart, derived.subtotal) <= 0
        if (unmet) {
          showToast('Promo dibatalkan: syarat beli belum terpenuhi')
          if (isSeparateSet)
            dispatch({ type: 'CART_REMOVE_PROMO_REWARDS', rewardPromotionId: p.id })
          dispatch({ type: 'CLEAR_PROMOTIONS' })
          return
        }
      }
    }
    // Precompute O(1) lookups once (the re-guard scans the full catalog per
    // applied code → O(n²) otherwise). Keep FIRST occurrence to match .find().
    const activeCodeByName = new Map<string, (typeof discountCodes)[number]>()
    for (const d of discountCodes) {
      if (!d.isActive) continue
      const key = d.code.toUpperCase()
      if (!activeCodeByName.has(key)) activeCodeByName.set(key, d)
    }
    const activePromoById = new Map<string, (typeof promotions)[number]>()
    for (const p of promotions) {
      if (!p.isActive) continue
      if (!activePromoById.has(p.id)) activePromoById.set(p.id, p)
    }
    for (const c of appliedPromoCodes) {
      const dc = activeCodeByName.get(c.code.toUpperCase())
      if (!dc) {
        showToast('Kode diskon dibatalkan: Kode tidak ditemukan')
        dispatch({ type: 'CLEAR_PROMOTIONS' })
        return
      }
      const vs = validateCode(dc, guardCtx)
      if (vs.length > 0) {
        showToast(`Kode diskon dibatalkan: ${violationMessage(vs[0])}`)
        dispatch({ type: 'REMOVE_PROMO_CODE', code: c.code })
        return
      }
      // SP-Promo-3c: for linked codes, also re-validate the linked promotion
      // (mirrors decideApplyCode's intersection rule)
      if (c.promotion) {
        const linkedPromo = activePromoById.get(c.promotion.id)
        if (!linkedPromo) {
          showToast('Kode diskon dibatalkan: Promo tertaut tidak tersedia')
          dispatch({ type: 'CLEAR_PROMOTIONS' })
          return
        }
        const promoVs = validatePromo(linkedPromo, guardCtx)
        if (promoVs.length > 0) {
          showToast(`Kode diskon dibatalkan: ${violationMessage(promoVs[0])}`)
          dispatch({ type: 'CLEAR_PROMOTIONS' })
          return
        }
      }
    }
    if (
      appliedPromotions.length + appliedPromoCodes.length > 1 &&
      (appliedPromotions.some((p) => !p.combinable) ||
        appliedPromoCodes.some((c) => !c.combinable))
    ) {
      showToast('Promo/Kode diskon dibatalkan: tidak bisa digabung')
      dispatch({ type: 'CLEAR_PROMOTIONS' })
      return
    }
    setSaleError(null)
    dispatch({ type: 'SET_PROCESSING', processing: true })
    try {
      // Client-authoritative number: receipt == history, generated on-device.
      // The number is reserved durably inside the sale gate, right before the enqueue.
      let orderNo = ''
      const quoteHolder: { current: ReceiptQuote | null } = { current: null }
      const promotionMetadata = buildPromotionMetadata(state, derived)
      // The sale only counts once it is durably queued: await the outbox write
      // BEFORE any success state, cart reset or receipt print.
      const outcome = await saleGate.current.run(async () => {
        const queuedNumbers = engine.outbox.all().flatMap((i) => (i.type === 'order' && typeof i.payload.orderNumber === 'string' ? [i.payload.orderNumber] : []))
        const reserved = await reserveOrderNo(engine.getSnapshot().outletCode, engine.deviceId, authStore.outletId, undefined, queuedNumbers)
        orderNo = reserved.orderNo
        if (reserved.error !== undefined) {
          void reportErrors([{ source: 'runtime', kind: 'order_seq_write', action: `Simpan nomor struk ${orderNo}`, message: reserved.error instanceof Error ? reserved.error.message : 'penyimpanan nomor struk gagal', outletName: snapshot.outletName }])
        }
        // A10: the receipt money and lines are built ONCE here; the same object is
        // queued as the quote and printed below (printed == quoted by construction).
        const quote = buildReceiptQuote({ cart: state.cart, derived, tender, refVersion: engine.referenceVersion() })
        quoteHolder.current = quote
        return engine.enqueue('order', {
        orderNumber: orderNo,
        items: state.cart,
        paymentMethod: state.paymentMethod,
        amountPaid: tender.amountPaid,
        customerId: state.selectedCustomer?.id ?? null,
        customerName: state.selectedCustomer?.name ?? null,
        salesmanId: state.selectedSalesman?.id ?? null,
        salesmanName: state.selectedSalesman?.name ?? null,
        discountType: state.discountRunning > 0 ? state.appliedDiscountType : null,
        discountValue: state.discountRunning > 0 ? state.discountRunning : null,
        surchargeValue: state.surchargeRunning > 0 ? state.surchargeRunning : null,
        surchargeType: state.surchargeRunning > 0 ? state.appliedSurchargeType : null,
        ...promotionMetadata,
        pointsRedeemed: derived.redeemedPoints > 0 ? derived.redeemedPoints : null,
        notes: state.orderNotes.trim() || null,
        shiftId: shift.currentShift?.id || null, // '' = open not yet synced
        quotedTotal: quote.quotedTotal,
        receiptSnapshot: quote.receiptSnapshot,
      })
      })
      if (outcome.status === 'busy') return
      if (outcome.status === 'failed') {
        // Nothing was queued or sent. Keep the cart/checkout open, show a
        // persistent error and do NOT print.
        dispatch({ type: 'SET_PROCESSING', processing: false })
        setSaleError(notSavedMessage('Transaksi'))
        void reportErrors([{ source: 'runtime', kind: 'outbox_write', action: `Simpan transaksi ${orderNo}`, message: outcome.error instanceof Error ? outcome.error.message : 'penyimpanan lokal gagal', outletName: snapshot.outletName }])
        return
      }
      const { orderUuid } = outcome.value
      // A saved sale always built its quote inside the gate (outcome.status 'ok').
      const receipt: ReceiptData = receiptFromQuote(quoteHolder.current!, {
        orderRef: orderNo,
        dateTime: new Date(),
        paymentLabel: PAYMENT_LABELS[state.paymentMethod] ?? state.paymentMethod,
        customerName: state.selectedCustomer?.name ?? null,
        customerPhone: state.selectedCustomer?.phone ?? null,
        cashierName: user?.displayName ?? 'Kasir',
      })
      lastReceipt.current = receipt
      setPrintError(null)
      dispatch({ type: 'ORDER_SUCCESS', orderId: orderUuid, orderNumber: orderNo })
      // Local BLE print — works offline, independent of sync (§6).
      // Auto-print on every successful sale when a printer is paired.
      if (printer.isPaired) {
        printer
          .print(receipt, settings.receipt)
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : 'Gagal mencetak'
            setPrintError(msg)
            void reportErrors([{ source: 'print', kind: 'receipt', action: `Cetak struk ${orderNo}`, message: msg, outletName: snapshot.outletName }])
          })
      }
    } catch { dispatch({ type: 'SET_PROCESSING', processing: false }) }
  }

  const handleReprint = () => {
    if (!lastReceipt.current) {
      // After a restart the ref is empty: fall back to the newest receipt kept on this tablet.
      const newest = newestReprintable(engine.localReceipts())
      if (newest) reprintLocal(newest)
      return
    }
    setPrintError(null)
    printer
      .print(lastReceipt.current, settings.receipt)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Gagal mencetak'
        setPrintError(msg)
        void reportErrors([{ source: 'print', kind: 'receipt', action: 'Cetak ulang struk', message: msg, outletName: snapshot.outletName }])
      })
  }

  // Reprint a receipt kept on this tablet (A41) from its stored snapshot, with the REPRINT marker. Never queues
  // anything and never goes through the sale gate; the customer is not stored locally, so none is printed.
  const reprintLocal = (r: LocalReceipt) => {
    if (!printer.isPaired) { showToast('Pasangkan printer untuk cetak ulang struk'); return }
    const receipt = reprintReceiptData(r)
    if (!receipt) { showToast('Struk ini tidak punya rincian yang bisa dicetak'); return }
    printer
      .print(receipt, settings.receipt, true)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Gagal mencetak struk'
        showToast(msg)
        void reportErrors([{ source: 'print', kind: 'receipt', action: `Cetak ulang struk ${r.orderNumber}`, message: msg, outletName: snapshot.outletName }])
      })
  }

  // Reprint a tanda terima for an already-completed transfer (from the history
  // panel). Same payload as the post-receive prompt, but stamps the REPRINT
  // marker. Mirrors handleReprint's error-reporting; needs a paired printer.
  const reprintTandaTerima = (t: Transfer) => {
    if (!printer.isPaired) { showToast('Pasangkan printer untuk cetak tanda terima'); return }
    printer
      .printTandaTerima(buildTandaTerimaData(t, user?.displayName ?? ''), settings.receipt, true)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Gagal mencetak tanda terima'
        showToast(msg)
        void reportErrors([{ source: 'print', kind: 'tanda_terima', action: `Cetak ulang tanda terima ${t.transferNo}`, message: msg, outletName: snapshot.outletName }])
      })
  }

  // Reprint a sales receipt for a past order (from the history panel). Reuses
  // the same ReceiptData shape as checkout, but stamps the REPRINT marker.
  // Orders carry every field the slip needs (no phone is stored on the order).
  const reprintOrder = (o: Order) => {
    if (!printer.isPaired) { showToast('Pasangkan printer untuk cetak ulang struk'); return }
    const receipt: ReceiptData = {
      orderRef: o.orderNumber,
      pending: false,
      dateTime: new Date(o.createdAt),
      lines: o.items.map((i) => ({
        name: i.productName,
        variant: variantLabel(i.variantSize) || undefined,
        qty: i.quantity,
        unitPrice: i.price,
        amount: i.subtotal,
      })),
      subtotal: o.subtotal,
      discountAmount: o.discountAmount,
      taxAmount: o.taxAmount,
      total: o.total,
      paymentLabel: PAYMENT_LABELS[o.paymentMethod] ?? o.paymentMethod,
      amountPaid: o.amountPaid,
      change: o.change,
      customerName: o.customerName ?? null,
      customerPhone: null,
      cashierName: o.cashierName,
    }
    printer
      .print(receipt, settings.receipt, true)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Gagal mencetak struk'
        showToast(msg)
        void reportErrors([{ source: 'print', kind: 'receipt', action: `Cetak ulang struk ${o.orderNumber}`, message: msg, outletName: snapshot.outletName }])
      })
  }

  const handleRefundConfirm = async (orderId: string, reason: string) => {
    if (refundGate.current.isBusy()) return
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      setRefundError(lockedMsg)
      return
    }
    setRefundError(null)
    // Defensive guards (the panel already hides the button): permission, an open synced shift, a valid
    // reason. The display snapshot is built here, once; nothing rewrites the payload after it is queued.
    if (refundSale) {
      // A local sale: a refund may already be queued or done under its uuid or server id (the panel hides the button too).
      const ids = [refundSale.orderUuid, refundSale.serverOrderId].filter((k): k is string => !!k)
      const synced = engine.syncedRefundOrderIds()
      const queuedIds = engine.queuedRefundOrderIds()
      const queuedUuids = engine.queuedRefundSaleUuids()
      if (ids.some((k) => synced.has(k))) { setRefundError(REFUND_DONE); return }
      if (ids.some((k) => queuedIds.has(k) || queuedUuids.has(k))) { setRefundError(REFUND_QUEUED); return }
    }
    const plan = planRefundSubmit({ refundOrder, orderId, reason, canRefund: canRefund(user), shiftId: shift.currentShift?.id, sale: refundSale ?? undefined })
    if (plan.kind === 'error') {
      setRefundError(plan.message)
      return
    }
    setIsRefunding(true)
    const outcome = await refundGate.current.run(() => engine.enqueue('refund', { ...plan.payload }))
    if (outcome.status === 'busy') return
    setIsRefunding(false)
    if (outcome.status === 'failed') {
      setRefundError(notSavedMessage('Refund'))
      return
    }
    setRefundOrder(null)
    setRefundSale(null)
    showToast('Refund diproses — stok dipulihkan saat sinkronisasi')
  }

  // A08: only called after the server minted a grant; the queued receive carries its id, never a PIN.
  const handleReceiveApproved = async (approvalGrantId: string) => {
    if (!pendingReceive) return
    const outcome = await receiveGate.current.run(() => engine.enqueueTransferReceive({
      orderUuid: pendingReceive.orderUuid,
      transferId: pendingReceive.transferId,
      items: pendingReceive.items,
      discrepancyReason: pendingReceive.reason,
      approvalGrantId,
    }))
    if (outcome.status === 'busy') return
    // The approval modal stays open and shows the error so the receive can be retried.
    if (outcome.status === 'failed') throw outcome.error
    setPendingReceive(null)
    showToast('Diterima — akan disinkronkan')
  }

  const handleFontSize = (s: FontSize) => { setFontSize(s); localStorage.setItem('pos_fontSize', s) }

  // Apply font size GLOBALLY by scaling the root rem unit. Tailwind text-* and
  // spacing are rem-based, so this resizes the whole app (product cards,
  // cart, modals) — not just one panel. (The old root text-sm class was
  // overridden by every component's explicit text-* class, so it did nothing.)
  useEffect(() => {
    const px = fontSize === 'sm' ? 14 : fontSize === 'lg' ? 18 : 16
    document.documentElement.style.fontSize = `${px}px`
    return () => { document.documentElement.style.fontSize = '' }
  }, [fontSize])
  const handleGridCols = (c: GridCols) => { setGridCols(c); localStorage.setItem('pos_gridCols', String(c)) }
  const handleShowPrice = (v: boolean) => { setShowPrice(v); localStorage.setItem('pos_cardPrice', v ? '1' : '0') }
  const handleShowStock = (v: boolean) => { setShowStock(v); localStorage.setItem('pos_cardStock', v ? '1' : '0') }
  const handleShowVariants = (v: boolean) => { setShowVariants(v); localStorage.setItem('pos_cardVariants', v ? '1' : '0') }

  // Drawer shortcut: open Settings scrolled to a section.
  const openSettings = (section?: SettingsSection) => { setSettingsSection(section); setShowSettings(true) }

  // Sharing diagnostics leaves failed operations available for explicit retry.
  const handleExportLog = async () => {
    // Report to the server error log too (covers the case where the items
    // dead-lettered while offline and weren't auto-reported yet).
    const dead = engine.reviewItems()
    if (dead.length) {
      void reportErrors(dead.map((d) => ({
        source: 'sync' as const, kind: d.type,
        action: `Kirim log: ${d.type}`,
        message: d.reviewReason ?? d.lastError ?? 'sync gagal',
        outletName: snapshot.outletName,
      })))
    }
    const outcome = await shareFailedSyncDiagnostics(offlineData.buildFailedSyncDiagnostics)
    showToast(diagnosticExportMessages[outcome])
  }

  // Android hardware Back: close the top-most surface instead of exiting.
  useEffect(() => {
    setBackHandler(() => {
      if (showMenu) { setShowMenu(false); return true }
      if (showSettings) { setShowSettings(false); return true }
      if (showHistory) { setShowHistory(false); return true }
      if (showLocalReceipts) { setShowLocalReceipts(false); return true }
      if (showTransferHistory) { setShowTransferHistory(false); return true }
      if (showRecap) { setShowRecap(false); return true }
      if (refundOrder) { setRefundOrder(null); setRefundSale(null); return true }
      if (state.isSuccessOpen) { dispatch({ type: 'CLOSE_SUCCESS' }); return true }
      if (state.isCheckoutOpen) { dispatch({ type: 'CLOSE_CHECKOUT' }); return true }
      if (state.activeAdjustment) { dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel: null }); return true }
      if (state.activeTab === 'cart') { dispatch({ type: 'SET_ACTIVE_TAB', tab: 'products' }); return true }
      // Nothing to navigate back to — still consume it. A POS must never be
      // closed/minimized by a stray Back press; only "Keluar" logs out.
      return true
    })
    return () => setBackHandler(null)
  }, [
    showMenu, showSettings, showHistory, showLocalReceipts, showTransferHistory, showRecap, refundOrder,
    state.isSuccessOpen, state.isCheckoutOpen, state.activeAdjustment,
    state.activeTab,
  ])

  if (!user) return null

  // Sales made on this tablet (A41): read only while a surface that needs them is open (the list is parsed from storage).
  const localReceipts: LocalReceipt[] = showHistory || showLocalReceipts ? engine.localReceipts() : []
  const saleUuidByServerId = new Map(localReceipts.flatMap((r): [string, string][] => (r.serverOrderId ? [[r.serverOrderId, r.orderUuid]] : [])))

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
      {/* Header — brand logo, then the active-shift chip and the live
          online/offline indicator in the same row (moved up out of the old
          shift bar / the drawer footer). */}
      <header className="bg-white border-b border-gray-100 px-3 py-2 flex items-center justify-between gap-2 flex-shrink-0 safe-top">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <img src={logoGold} alt="Mandalika POS" className="h-6 w-auto object-contain flex-shrink-0" />
          {/* Read-only: the terminal's outlet is fixed (A04); change it only via Lepas terminal. */}
          {outletLabel && <span className="text-xs font-semibold text-gray-600 truncate flex-shrink min-w-0" title="Outlet terminal">{outletLabel}</span>}
          <ShiftBar
            currentShift={shift.currentShift} isLoading={shift.isLoadingShift}
            isOpening={shift.isOpeningShift}
            onOpenShift={shift.openShift}
            isOnline={offlineData.isOnline} canOpen={shift.canOpenShift}
            error={shift.shiftError}
            onRequestClose={() => { setCloseIntent(true); setShowRecap(true) }}
            promptOpen={shiftPrompt} onPromptConsumed={() => setShiftPrompt(false)}
          />
          {/* Online/offline pill — label always visible (incl. portrait). */}
          <div
            className={`flex items-center gap-1 flex-shrink-0 px-1.5 py-0.5 rounded-full ${offlineData.isOnline ? 'bg-green-50' : 'bg-gray-100'}`}
            title={offlineData.isOnline ? 'Online' : 'Offline'}
          >
            <span className={`w-2 h-2 rounded-full ${offlineData.isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className={`text-[11px] font-semibold ${offlineData.isOnline ? 'text-green-600' : 'text-gray-400'}`}>
              {offlineData.isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <SyncStatus
            isOnline={offlineData.isOnline} pendingCount={offlineData.pendingCount}
            review={offlineData.review} stuck={offlineData.stuck} accountProblem={offlineData.accountProblem} wall={offlineData.wall}
            offlineCap={offlineCap} isResyncing={offlineData.isResyncing} autoUpdate={offlineData.autoPullAvailable}
            onResync={() => void offlineData.resync()} onFlush={offlineData.flush}
            onRetryFailed={() => { offlineData.retryFailed().catch(() => showToast('Gagal menyetel ulang antrean. Coba lagi.')) }} onExportLog={() => { void handleExportLog() }}
          />
          <button type="button"
            onClick={() => setShowMenu(true)}
            className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Menu" aria-label="Menu"
          >
            <svg className="w-5 h-5 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
            {(offlineData.pendingCount > 0 || inbound.length > 0) && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
        </div>
      </header>

      {shift.shiftError && (
        <div role="alert" className="bg-red-700 text-white text-sm font-semibold px-4 py-2 flex items-center justify-between gap-3 flex-shrink-0">
          <span>{shift.shiftError}</span>
          <button type="button" onClick={shift.clearShiftError} className="text-xs underline flex-shrink-0">Tutup</button>
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Mobile tab bar — cart tab only appears when the cart has items. */}
        <div className={`sm:hidden absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-10 safe-bottom-tab ${derived.totalCartItems > 0 ? 'flex' : 'hidden'}`}>
          {(['products', 'cart'] as const).map((tab) => (
            <button type="button" key={tab} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab })}
              className={`flex-1 py-3 text-xs font-bold relative ${state.activeTab === tab ? 'text-indigo-600 border-t-2 border-indigo-600' : 'text-gray-500'}`}>
              {tab === 'products' ? 'Produk' : 'Keranjang'}
              {tab === 'cart' && derived.totalCartItems > 0 && (
                <span className="absolute top-1.5 right-8 bg-indigo-600 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
                  {derived.totalCartItems}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Product panel */}
        <div className={`flex-1 min-w-0 overflow-hidden sm:block ${state.activeTab === 'cart' ? 'hidden' : 'block'}`}>
          <CustomerPicker
            customers={customers} selectedCustomer={state.selectedCustomer}
            customerSearch={state.customerSearch} isAddingCustomer={isAddingCustomer}
            newCustomerForm={newCustomerForm} isSaving={isSavingCustomer}
            onSearchChange={(q) => dispatch({ type: 'SET_CUSTOMER_SEARCH', search: q })}
            onSelect={(c) => { getKnownCustomers().remember(c); dispatch({ type: 'SET_CUSTOMER', customer: c }) }}
            onClear={() => dispatch({ type: 'SET_CUSTOMER', customer: null })}
            onToggleAdding={() => { setIsAddingCustomer((v) => !v); setCustomerError(null) }}
            onNewFormChange={(f, v) => setNewCustomerForm((prev) => ({ ...prev, [f]: v }))}
            onSaveNew={() => void handleAddCustomer()}
            earnedPoints={derived.earnedPoints}
            onAddNewFromSearch={handleAddNewFromSearch}
            errorText={customerError}
            loyaltyEnabled={loyalty.enabled}
            isSearching={lookupPending} lookupError={lookupError}
            awaitingSearch={awaitingSearch(state.customerSearch, offlineData.isOnline, lookupRequest?.text ?? null)}
            onSubmitSearch={() => setLookupRequest((prev) => ({ text: state.customerSearch.trim(), n: (prev?.n ?? 0) + 1 }))}
          />
          <ProductGrid
            products={displayProducts} categories={categories}
            selectedCategoryId={selectedCategoryId} searchQuery={searchQuery}
            showFavouritesOnly={showFavouritesOnly} gridCols={gridCols}
            showPrice={showPrice} showStock={showStock} showVariants={showVariants}
            onProductTap={handleProductTap}
            onCategoryChange={setSelectedCategoryId} onSearchChange={setSearchQuery}
            onSearchSubmit={handleSearchSubmit}
            onScanClick={() => void handleCameraScan()}
            onToggleFavourites={() => setShowFavouritesOnly((v) => !v)} isLoading={false}
          />
        </div>

        {/* Cart panel — only mounts once the cart has items (dynamic). */}
        {derived.totalCartItems > 0 && (
          <div className={`w-full sm:w-80 flex-shrink-0 flex-col sm:flex pb-20 sm:pb-0 ${state.activeTab === 'products' ? 'hidden sm:flex' : 'flex'}`}>
            <Cart
              cart={state.cart} derived={derived} settings={settings}
              selectedCustomer={state.selectedCustomer}
              pendingSync={offlineData.pendingCount > 0}
              onRemove={cartActions.removeItem} onSetQty={cartActions.setQty}
              onClear={cartActions.clearCart}
              onCheckout={handleCheckout}
              onOpenAdjustment={(panel) => dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel })}
              discountRunning={state.discountRunning} discountType={state.appliedDiscountType}
              surchargeRunning={state.surchargeRunning}
              orderNotes={state.orderNotes}
              appliedPromotions={state.appliedPromotions}
              appliedPromoCodes={state.appliedPromoCodes}
              onRemovePromotion={(id) => dispatch({ type: 'REMOVE_PROMOTION', id })}
              onRemovePromoCode={(code) => dispatch({ type: 'REMOVE_PROMO_CODE', code })}
              onClearDiscount={() => dispatch({ type: 'CLEAR_DISCOUNT' })}
              loyaltyEnabled={loyalty.enabled}
              wallRaised={false}
            />
          </div>
        )}
      </div>

      {/* Floating panels */}
      <AdjustmentDrawer
        state={state} dispatch={dispatch} promotions={promotions} discountCodes={discountCodes}
        subtotal={derived.subtotal} outletId={authStore.outletId ?? ''} timezone={outletTimezone} isValidatingCode={isValidatingCode}
        onSelectPromotion={handleSelectPromotion}
        onApplyPromoCode={() => void handleApplyPromoCode()}
        onApplyDiscount={cartActions.applyDiscount}
        onApplySurcharge={cartActions.applySurcharge}
        promoCodeError={promoCodeError}
        onClearPromoCodeError={() => setPromoCodeError(null)}
      />

      <CheckoutPanel
        isOpen={state.isCheckoutOpen} isProcessing={state.isProcessing}
        derived={derived} settings={settings} paymentMethod={state.paymentMethod}
        amountPaid={state.amountPaid} selectedCustomer={state.selectedCustomer}
        orderNotes={state.orderNotes}
        salesmen={salesmen} selectedSalesmanId={state.selectedSalesman?.id ?? null}
        onSelectSalesman={(s) => dispatch({ type: 'SET_SALESMAN', salesman: s })}
        loyaltyEnabled={loyalty.enabled}
        customerPoints={state.selectedCustomer?.points ?? 0}
        rewards={rewards}
        rewardsLoading={rewardsLoading}
        stockProducts={displayProducts}
        pickedRewards={pickedRewards}
        onPickReward={handlePickReward}
        onClearReward={handleClearReward}
        pointsToRedeem={state.pointsToRedeem}
        onPointsRedeemedChange={(p) => dispatch({ type: 'SET_POINTS_REDEEMED', points: p })}
        onPaymentMethodChange={(m) => dispatch({ type: 'SET_PAYMENT_METHOD', method: m })}
        onAmountPaidChange={(a) => dispatch({ type: 'SET_AMOUNT_PAID', amount: a })}
        onConfirm={() => void handleConfirmPayment()}
        saveError={saleError}
        onClose={() => { setSaleError(null); dispatch({ type: 'CLOSE_CHECKOUT' }) }}
        discountAmount={derived.discountAmount} taxAmount={derived.taxAmount}
        allowNegativeStock={settings.allowNegativeStock ?? true}
        cartLines={state.cart}
      />

      <ReceiptPreview
        isOpen={state.isSuccessOpen} orderId={state.lastOrderId} orderNumber={state.lastOrderNumber} items={state.cart}
        total={derived.total} discountAmount={derived.discountAmount} taxAmount={derived.taxAmount}
        paymentMethod={state.paymentMethod}
        amountPaid={tender.amountPaid}
        change={tender.change}
        customerName={state.selectedCustomer?.name ?? null} cashierName={user.displayName}
        settings={settings} isPendingSync={offlineData.pendingCount > 0}
        canReprint={printer.isPaired} printError={printError}
        promoLabel={
          derived.manualDiscountAmount > 0
            ? null
            : (state.appliedPromotions[0]?.name ?? state.appliedPromoCodes[0]?.code ?? null)
        }
        onReprint={handleReprint}
        onClose={() => dispatch({ type: 'CLOSE_SUCCESS' })}
        onNewSale={() => dispatch({ type: 'RESET_SALE' })}
      />

      <ShiftRecapPanel
        isOpen={showRecap}
        onClose={() => { setShowRecap(false); setCloseIntent(false) }}
        paymentMethods={settings.paymentMethods}
        userName={user.displayName}
        userRole={user.role}
        outletName={snapshot.outletName ?? 'Mandalika'}
        closeIntent={closeIntent}
        receipt={settings.receipt}
        onOpenShift={shift.openShift}
        onCloseShift={shift.closeShift}
        shiftError={shift.shiftError}
        isOpeningShift={shift.isOpeningShift}
        isClosingShift={shift.isClosingShift}
        queuedRefunds={engine.queuedRefunds()}
      />

      <MenuDrawer
        open={showMenu}
        onClose={() => setShowMenu(false)}
        user={user}
        shiftActive={!!shift.currentShift}
        pendingSync={offlineData.pendingCount > 0}
        isSyncing={offlineData.isResyncing}
        lastSyncedLabel={offlineData.lastSyncedAt
          ? new Date(offlineData.lastSyncedAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : null}
        onTakeOrder={() => setShowMenu(false)}
        onHistory={() => setShowHistory(true)}
        onLocalReceipts={() => setShowLocalReceipts(true)}
        onRecap={() => setShowRecap(true)}
        onCashFlow={() => openSettings('cashflow')}
        onSync={() => void offlineData.resync()}
        onPrintSettings={() => openSettings('printer')}
        onProductDisplay={() => openSettings('display')}
        onBackOffice={() => window.open('https://mandalika-pos.pages.dev', '_system')}
        onTerminal={() => openSettings('terminal')}
        onReceiveTransfer={() => setShowReceive(true)}
        onOpenTransferHistory={() => setShowTransferHistory(true)}
        inboundCount={inbound.length}
      />

      <OrderHistoryPanel
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        onRefund={(o) => { setShowHistory(false); setRefundSale(null); setRefundOrder(o) }}
        onReprint={reprintOrder}
        canReprint={printer.isPaired}
        timezone={outletTimezone}
        shiftOpenedAt={shift.currentShift?.openedAt}
        {...refundGateProps({ user, currentShift: shift.currentShift, queuedOrderIds: engine.queuedRefundOrderIds(), syncedRefundOrderIds: engine.syncedRefundOrderIds(), queuedSaleUuids: engine.queuedRefundSaleUuids(), serverIdToSaleUuid: saleUuidByServerId })}
      />

      <LocalReceiptsPanel
        isOpen={showLocalReceipts}
        onClose={() => setShowLocalReceipts(false)}
        receipts={localReceipts}
        canReprint={printer.isPaired}
        onReprint={reprintLocal}
        onRefund={(r) => { setShowLocalReceipts(false); setRefundSale(localSaleRef(r)); setRefundOrder(localReceiptOrder(r)) }}
        {...refundGateProps({ user, currentShift: shift.currentShift, queuedOrderIds: engine.queuedRefundOrderIds(), syncedRefundOrderIds: engine.syncedRefundOrderIds(), queuedSaleUuids: engine.queuedRefundSaleUuids(), serverIdToSaleUuid: saleUuidByServerId })}
      />

      <RefundDialog order={refundOrder} isProcessing={isRefunding} error={refundError}
        onConfirm={(id, reason) => { void handleRefundConfirm(id, reason) }}
        onClose={() => { setRefundError(null); setRefundOrder(null); setRefundSale(null) }} />

      {showReceive && (
        <ReceiveTransferPanel
          transfers={inbound}
          completedTransfers={completedTransfers}
          onClose={() => setShowReceive(false)}
          onConfirm={(transferId, items, reason) => {
            setShowReceive(false)
            // The receipt key exists before the approval is asked for and survives retries.
            const key = engine.newReceiveKey()
            setPendingReceive({ transferId, items, reason, orderUuid: key.orderUuid, receiptKey: key.idempotencyKey })
          }}
          onReprintTandaTerima={(t) => { setShowReceive(false); setPendingTT(t) }}
        />
      )}

      {showTransferHistory && (
        <TransferHistoryPanel
          onClose={() => setShowTransferHistory(false)}
          onReprint={reprintTandaTerima}
        />
      )}

      {pendingReceive && (
        <ReceiveApprovalModal
          receiptKey={pendingReceive.receiptKey}
          transferId={pendingReceive.transferId}
          items={pendingReceive.items}
          reason={pendingReceive.reason}
          listApprovers={() => engine.listReceiveApprovers()}
          requestApproval={(input) => engine.requestReceiveApproval(input)}
          onCancel={() => setPendingReceive(null)}
          onApproved={handleReceiveApproved}
        />
      )}

      {pendingTT && (
        <TandaTerimaPrompt
          transfer={pendingTT}
          receivedByName={user?.displayName ?? ''}
          receiptSettings={settings.receipt}
          onClose={() => setPendingTT(null)}
        />
      )}

      {pendingFulfillment?.kind === 'bxgy-picker' && (
        <BxgyRewardModal
          promo={pendingFulfillment.promo}
          options={pendingFulfillment.options}
          due={pendingFulfillment.due}
          stockProducts={displayProducts}
          onConfirm={handleBxgyRewardConfirm}
          onCancel={() => setPendingFulfillment(null)}
        />
      )}

      {pendingFulfillment?.kind === 'bundle-picker' && (
        <BundleSlotPicker
          cfg={pendingFulfillment.cfg}
          cart={pendingFulfillment.cart}
          promoName={pendingFulfillment.promo.name}
          stockFor={(pid, size) => stockFor(displayProducts, pid, size)}
          onConfirm={handleBundlePickerConfirm}
          onCancel={() => setPendingFulfillment(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-gray-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg safe-bottom">
          {toast}
        </div>
      )}

      {showSettings && (
        <SettingsScreen
          section={settingsSection ?? 'display'}
          settings={settings} currentShift={shift.currentShift}
          fontSize={fontSize} gridCols={gridCols}
          showPrice={showPrice} showStock={showStock} showVariants={showVariants}
          onFontSizeChange={handleFontSize} onGridColsChange={handleGridCols}
          onShowPriceChange={handleShowPrice} onShowStockChange={handleShowStock}
          onShowVariantsChange={handleShowVariants}
          onClose={() => { setShowSettings(false); setSettingsSection(undefined) }}
        />
      )}
    </div>
  )
}
