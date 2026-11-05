/**
 * Orchestrator — no business logic, composes leaf components.
 * Data from SyncEngine snapshot (offline-first); writes via engine.enqueue.
 */

import { use, useReducer, useRef, useState, useEffect, useLayoutEffect, useMemo } from 'react'
import type { components } from '@mandalika/api'
import { normalizePhone, uuid, type LocalReceipt } from '@mandalika/sync'
import { canRefund, canRequestStock, isCashMethod, variantLabel } from '@mandalika/types'
import type { ReceiptData } from '@mandalika/printer'
import { SyncContext, SyncReceiveRejectedRefContext, SyncReceiveAcceptedRefContext } from './SyncProvider'
import { useAutoPullGate } from './autoPullGate'
import { TandaTerimaPrompt } from './transfers/TandaTerimaPrompt'
import { buildTandaTerimaData } from './transfers/buildTandaTerimaData'
import { TransferHistoryPanel } from './TransferHistoryPanel'
import { RequisitionPanel } from './requisitions/RequisitionPanel'
import { usePrinter } from '../printer'
import { setBackHandler } from '../native'
import { readCardPref } from '../lib/cardPrefs'
import { BLIND_COUNT_DEFAULT } from './countRules'
import { useAuth } from '../auth'
import { useOfflineData } from '../hooks/useOfflineData'
import { useOfflineCap } from '../hooks/useOfflineCap'
import { OFFLINE_LOCKED_MESSAGE, offlineLockMessage } from '../lib/offlineCap'
import { Banner, IconMenu } from '../components/ui'
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
import { CustomerChip } from './CustomerChip'
import { CustomerProfileSheet } from './CustomerProfileSheet'
import { chipRewards, localHistoryFor, planOne, planRepeat, recentCustomers, rewardsAvailableCount } from './customerProfile'
import { useLoyaltyRewards } from '../hooks/useLoyaltyRewards'
import { useCustomerProfile } from '../hooks/useCustomerProfile'
import { awaitingSearch, finderHits, getKnownCustomers, lookupFailureMessage, newCustomerProblem, prefillFromSearch } from './customerFinder'
import { AdjustmentDrawer } from './AdjustmentDrawer'
import { MenuDrawer } from './MenuDrawer'
import { ReceiveTransferPanel } from './receive/ReceiveTransferPanel'
import { ReceiveApprovalModal } from './receive/ReceiveApprovalModal'
import { ShiftBar } from './ShiftBar'
import { ReceiptPreview } from './ReceiptPreview'
import { orderStateFor } from './orderState'
import { RefundDialog, type RefundConfirmInput } from './RefundDialog'
import type { RefundCache } from './refundSelection'
import type { HistoryFocus } from './OrderHistoryPanel'
import { withSaleLineData } from './saleLineData'
import { REFUND_DONE, REFUND_QUEUED, orderReceiptTenders, planRefundSubmit, refundGateProps, type LocalSaleRef } from './refundView'
import { OrderHistoryPanel } from './OrderHistoryPanel'
import { LocalReceiptsPanel } from './LocalReceiptsPanel'
import { localReceiptOrder, localSaleRef, newestReprintable, reprintReceiptData } from './localReceipts'
import { ShiftRecapPanel } from './ShiftRecapPanel'
import { SyncStatus } from '../components/SyncStatus'
import { useParkedBanner } from '../hooks/useParkedBanner'
import { useOtaUpdate } from '../hooks/useOtaUpdate'
import { OTA_BLOCK_COPY, otaBlockReason, otaGate, type OtaGateInput } from '../lib/otaApplyGate'
import { parkedSaleMessage } from '../lib/parkedSale'
import { SettingsScreen, type SettingsSection } from '../screens/SettingsScreen'
import { reserveOrderNo } from './orderRef'
import { isRedundantPromoCode } from './promotionSelection'
import { buildPromotionMetadata } from './promotionMetadata'
import { quoteTotalRows } from './receiptRows'
import { buildReceiptQuote, receiptFromQuote, type ReceiptQuote } from './receiptQuote'
import { applyPendingStock, stockFor, oversoldSizes, OVERSELL_WARNING } from './stock'
import { giveawayLine, giveawayStock } from './giveaway'
import { isLineInBundle, planSizeSwitch, SIZE_SWITCH_BUNDLE_MESSAGE } from './lineSizes'
import { decideApplyCode } from './promoValidate'
import { resolveConfirmGuard } from './confirmGuard'
import { cashierBackLayer } from './backGuard'
import { customerAttachImpact, customerAttachMessage } from './customerAttachImpact'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { Button } from '../components/ui/Button'
import { HeldOrdersSheet } from './HeldOrdersSheet'
import { useHeldOrders } from './useHeldOrders'
import { planPromotionFulfillment, invalidPhysicalPromotionIds, type PromotionOwner, type PendingFulfillment } from './promotionFulfillment'
import type { BxgyRewardPick } from './BxgyRewardModal'
import type { BundleAssignment } from './bundle'
import { api, authStore } from '../api'
import { reportErrors } from '../lib/errorReporter'
import { diagnosticExportMessages, shareFailedSyncDiagnostics } from '../lib/failedSyncDiagnostics'
import { track } from '../lib/activityLog'
import { createSubmitGate, notSavedMessage } from '../lib/durableSubmit'
import { brand, hasFeature } from '../brand'
import { PAYMENT_LABELS, tenderLabel } from '../lib/paymentLabels'
import { cashPredicate, planSaleTender, salePaymentFields, snapshotTenders } from './tenderSplit'
import { useSplitDraft } from './useSplitDraft'
import { draftChargedSummary } from './splitDraft'

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
  receipt: { headerText: brand.receiptHeader, footerText: '', showTax: true, showCashier: true },
  autoOpenShift: false,
  allowNegativeStock: true,
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
  // Product-card details — price and stock on unless switched off (D-9), variants off unless switched on; toggled in display settings.
  const [showPrice, setShowPrice] = useState(() => readCardPref('pos_cardPrice', true))
  const [showStock, setShowStock] = useState(() => readCardPref('pos_cardStock', true))
  const [showVariants, setShowVariants] = useState(() => readCardPref('pos_cardVariants', false))
  // D-4 blind count at Tutup Shift: ON by default (owner 2026-11-05); a manager can switch it off in Pengaturan.
  const [blindCount, setBlindCount] = useState(() => readCardPref('pos_blindCount', BLIND_COUNT_DEFAULT))
  const [showSettings, setShowSettings] = useState(false)
  // Which settings section to scroll to when opened from a drawer shortcut.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddingCustomer, setIsAddingCustomer] = useState(false)
  // B3: the Pelanggan sheet (find / attach) and the Profil Pelanggan sheet (a customer's history), over the cart column.
  const [showCustomerSheet, setShowCustomerSheet] = useState(false)
  const [profileCustomer, setProfileCustomer] = useState<Customer | null>(null)
  const [profileNow, setProfileNow] = useState(0)
  const openProfile = (c: Customer) => { setProfileNow(Date.now()); setProfileCustomer(c) }
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
  // C4b: set when Riwayat is opened from a local receipt that must be refunded there (no line data, already synced).
  const [historyFocus, setHistoryFocus] = useState<HistoryFocus | null>(null)
  // Set while the refund dialog is open for a sale made on this tablet (a local receipt): its identity rides into the payload.
  const [refundSale, setRefundSale] = useState<LocalSaleRef | null>(null)
  const [showRecap, setShowRecap] = useState(false)
  // Raised when the recap was opened to close the shift (header "Tutup") — the
  // panel then requires counted income before allowing the close.
  const [closeIntent, setCloseIntent] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [showTransferHistory, setShowTransferHistory] = useState(false)
  const [showRequisitions, setShowRequisitions] = useState(false)
  const requisitionBackRef = useRef<(() => boolean) | null>(null)
  const recapBackRef = useRef<(() => boolean) | null>(null)
  const variantBackRef = useRef<(() => boolean) | null>(null)
  const lineBackRef = useRef<(() => boolean) | null>(null)
  const [pendingReceive, setPendingReceive] = useState<null | { transferId: string; items: { productId: string; variantSize: string; receivedQty: number }[]; reason: string; orderUuid: string; receiptKey: string }>(null)
  // Raised when the cashier tries to sell with no open shift → forces the
  // ShiftBar open-shift modal (selling without a shift is not allowed).
  const [shiftPrompt, setShiftPrompt] = useState(false)
  const printer = usePrinter()
  const lastReceipt = useRef<ReceiptData | null>(null)
  /** What the success view shows of the payment (ORDER_SUCCESS clears the split lines, and the single-mode inputs are re-derived on a new sale). */
  const lastPayment = useRef<{ paymentMethod: string; amountPaid: number; change: number } | null>(null)
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
  // C3: the outlet giveaway the server adds to every sale, shown as a derived Rp0 line (never in state.cart).
  const giveawayConfig = hasFeature('giveaway') ? snapshot.outletGiveaway : undefined
  const giveaway = giveawayLine(state.cart, giveawayConfig, giveawayConfig ? giveawayStock(giveawayConfig, displayProducts, pendingStockDeltas) : 0)
  // The totals block of the checkout sheet and of the receipt preview, from the same quote the printer uses.
  const checkoutRows = state.isCheckoutOpen ? quoteTotalRows(state.cart, derived, { showSubtotal: true, showDiscount: true, showTax: settings.taxEnabled }) : []
  const receiptRows = state.isSuccessOpen ? quoteTotalRows(state.cart, derived, settings.receipt) : []
  const parked = useParkedBanner(engine, offlineData.review, derived.totalCartItems === 0)

  // Cart panel hides when empty; if the mobile cart tab was active when the
  // last item left, fall back to products so the screen is never blank.
  useEffect(() => {
    if (derived.totalCartItems === 0 && state.activeTab === 'cart') {
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'products' })
    }
  }, [derived.totalCartItems, state.activeTab])

  // B3: the reward preview lives in the cart (online only); the chip and the checkout read the same state.
  const { rewards, loading: rewardsLoading } = useLoyaltyRewards({
    customerId: state.selectedCustomer?.id ?? null, enabled: loyalty.enabled, online: offlineData.isOnline, cart: state.cart, total: derived.total,
  })

  const customerProfile = useCustomerProfile(profileCustomer, offlineData.isOnline)

  // Pending picker context has no effect on the sale until confirmed.
  // Open confirm dialog (customer change, Kosongkan); Back and Batal dismiss it.
  const [confirm, setConfirm] = useState<{ message: string; confirmLabel: string; tone: 'danger' | 'primary'; run: () => void; onCancel?: () => void } | null>(null)
  const [pendingFulfillment, setPendingFulfillment] = useState<PendingFulfillment | null>(null)
  // Background reference pull (auto-pull): the engine may swap the catalog only while nothing is in flight.
  useAutoPullGate(engine, {
    cartCount: state.cart.length, isCheckoutOpen: state.isCheckoutOpen, isProcessing: state.isProcessing,
    isSuccessOpen: state.isSuccessOpen, hasRefundOrder: !!refundOrder, hasRefundSale: !!refundSale, isRefunding,
    showReceive, hasPendingReceive: !!pendingReceive, hasPendingTT: !!pendingTT, hasPendingFulfillment: !!pendingFulfillment,
    isAddingCustomer, isSavingCustomer, hasActiveAdjustment: !!state.activeAdjustment, showHistory, showLocalReceipts,
    showRecap, showTransferHistory, showRequisitions, showSettings, showMenu, shiftPrompt, closeIntent,
    hasSelectedCustomer: !!state.selectedCustomer, hasSelectedSalesman: !!state.selectedSalesman,
    appliedPromotionCount: state.appliedPromotions.length, appliedPromoCodeCount: state.appliedPromoCodes.length,
    pointsToRedeem: state.pointsToRedeem,
  })

  // C5 (D-19): a downloaded app version may be applied only while nothing is mid-sale. The gate reads the
  // single-flight refs live, so a sale started after the last render still blocks the restart at tap time.
  const ota = useOtaUpdate()
  const [otaBannerDismissed, setOtaBannerDismissed] = useState<string | null>(null)
  const otaGateBase = {
    cartCount: state.cart.length, isCheckoutOpen: state.isCheckoutOpen, isProcessing: state.isProcessing, isSuccessOpen: state.isSuccessOpen,
    refundActive: !!refundOrder || !!refundSale || isRefunding,
  }
  // Display (render): state-derived only. Tap (event handler): also the live gate refs.
  const otaStateWrites = isSavingCustomer || shift.isOpeningShift || shift.isClosingShift
  const otaRenderBlock = otaBlockReason({ ...otaGateBase, writesInFlight: otaStateWrites })
  // The tap reads the gate through a ref set in a layout effect: it sees the latest render AND the live gate refs.
  const otaGateRef = useRef<() => OtaGateInput>(() => ({ ...otaGateBase, writesInFlight: true }))
  useLayoutEffect(() => {
    otaGateRef.current = () => otaGate(otaGateBase, otaStateWrites, [saleGate, refundGate, customerGate, receiveGate])
  })
  const handleOtaRestart = () => {
    void ota.controller.restart(() => otaGateRef.current()).then((r) => {
      if (r === 'blocked') showToast(OTA_BLOCK_COPY[otaBlockReason(otaGateRef.current()) ?? 'saving'])
    })
  }

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const defaultMethod = enabledMethods[0]?.id ?? 'cash'
  const tender = cashTender(isCashMethod(settings.paymentMethods, state.paymentMethod), state.amountPaid, derived.total)
  const isCashId = cashPredicate(settings.paymentMethods)
  const methodLabel = (id: string): string => tenderLabel(id, settings.paymentMethods)
  const successPayment = lastPayment.current ?? { paymentMethod: state.paymentMethod, amountPaid: tender.amountPaid, change: tender.change }

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

  // D-6: carts parked on this tablet (never queued, never sent). Restore re-validates promos against the live catalog.
  const heldOrders = useHeldOrders({
    outletId: authStore.outletId ?? '', state, dispatch, ensureShift, offlineLock, showToast,
    askConfirm: (c) => setConfirm(c),
    getEnv: () => ({ products: displayProducts, promotions, discountCodes, ctx: { now: new Date(), outletId: authStore.outletId ?? '', timezone: outletTimezone } }),
  })
  const { open: heldOpen, setOpen: setHeldOpen } = heldOrders

  // C6 D-62: an unfinished split payment survives an app kill (the draft owns the sale's order uuid).
  const splitDraft = useSplitDraft({
    outletId: authStore.outletId ?? '', state, total: derived.total, dispatch, isCash: isCashId, defaultMethod,
    getEnv: () => ({ products: displayProducts, promotions, discountCodes, ctx: { now: new Date(), outletId: authStore.outletId ?? '', timezone: outletTimezone } }),
    saleUuids: () => new Set([
      ...engine.outbox.all().flatMap((i) => (i.type === 'order' && typeof i.payload.orderUuid === 'string' ? [i.payload.orderUuid] : [])),
      ...engine.localReceipts().map((r) => r.orderUuid),
    ]),
    ensureShift, offlineLock, showToast,
  })

  // A44 owner decision 2026-10-16: an out-of-stock item is never blocked. The line is
  // added and the cashier is warned; the server records the oversell. Returns true when
  // the add passes the (pending-adjusted) stock so scan can pick the right toast.
  const addWithStockWarning = (
    product: components['schemas']['Product'],
    variantQtys: Record<string, number>,
  ): 'blocked' | 'oversold' | 'added' => {
    if (!ensureShift()) return 'blocked'
    // The banner reads a 30 s poll while this gate reads the engine live, so always say why a tap did nothing.
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      showToast(lockedMsg)
      return 'blocked'
    }
    track(`Tambah ${product.name}`)
    const inCart = (size: string) => state.cart
      .filter((i) => i.productId === product.id && i.variantSize === size)
      .reduce((s, i) => s + i.quantity, 0)
    const oversold = oversoldSizes(product, variantQtys, inCart).length > 0
    cartActions.addVariants(product, variantQtys)
    return oversold ? 'oversold' : 'added'
  }

  const handleProductTap = (
    product: components['schemas']['Product'],
    variantQtys: Record<string, number>,
  ) => {
    if (addWithStockWarning(product, variantQtys) === 'oversold') showToast(OVERSELL_WARNING)
  }

  // B1 line sheet size switch: the existing remove + add actions (planSizeSwitch), through
  // the same add path as a tile tap so the oversell warning applies. The add's own gates
  // (open shift, offline lock) are checked FIRST so a blocked add never strands the removal.
  // Returns true only when the line moved.
  const handleSwitchSize = (productId: string, fromSize: string, toSize: string): boolean => {
    const product = displayProducts.find((p) => p.id === productId)
    const line = state.cart.find((i) => i.productId === productId && i.variantSize === fromSize && !i.isReward)
    if (!product || !line) return false
    const plan = planSizeSwitch(line, product, toSize)
    if (!plan) return false
    if (isLineInBundle(state.bundleFreed, productId, fromSize)) {
      // CART_REMOVE_ITEM would evict the bundle and its moved units would not follow the switch.
      showToast(SIZE_SWITCH_BUNDLE_MESSAGE)
      return false
    }
    if (!ensureShift()) return false
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      showToast(lockedMsg)
      return false
    }
    cartActions.removeItem(plan.productId, plan.fromSize)
    const result = addWithStockWarning(product, plan.variantQtys)
    if (result === 'oversold') showToast(OVERSELL_WARNING)
    return result !== 'blocked'
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
    const result = addWithStockWarning(product, { [variant.size]: 1 })
    if (result === 'blocked') return
    showToast(result === 'oversold'
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

  // A customer change silently strips reward lines and bundle/giveaway promos (SET_CUSTOMER), so
  // confirm first when that would actually remove something. The reducer's semantics are unchanged.
  const dismissConfirm = () => { confirm?.onCancel?.(); setConfirm(null) }
  const requestSetCustomer = (customer: components['schemas']['Customer'] | null, onCancel?: () => void) => {
    const names = customerAttachImpact(state)
    if (names.length === 0) { dispatch({ type: 'SET_CUSTOMER', customer }); return }
    const change = customer === null ? 'release' : state.selectedCustomer ? 'replace' : 'attach'
    setConfirm({ message: customerAttachMessage(names, change), confirmLabel: 'Lanjutkan', tone: 'primary', run: () => dispatch({ type: 'SET_CUSTOMER', customer }), onCancel })
  }

  const closeCustomerSheet = () => {
    setShowCustomerSheet(false)
    setIsAddingCustomer(false)
    setCustomerError(null)
    dispatch({ type: 'SET_CUSTOMER_SEARCH', search: '' })
  }

  // Ulangi / Sering dibeli: the same add path as a tile tap (shift and offline gates, stock warning). A Rp0 reward
  // line is never repeated; a size the catalog no longer sells is named, not silently dropped.
  const addPlanned = (plan: ReturnType<typeof planRepeat>) => {
    let oversold = false
    let added = 0
    for (const a of plan.adds) {
      const result = addWithStockWarning(a.product, a.variantQtys)
      if (result === 'blocked') return
      if (result === 'oversold') oversold = true
      added += Object.values(a.variantQtys).reduce((n, q) => n + q, 0)
    }
    if (plan.skipped.length > 0) showToast(`Tidak bisa diulang: ${plan.skipped.join(', ')} (sudah tidak dijual)`)
    else if (oversold) showToast(OVERSELL_WARNING)
    else if (added > 0) showToast(`${added} item ditambahkan ke keranjang`)
  }

  // Closing the Promo & Diskon sheet (x, backdrop, Back) also drops a picker that was open in it.
  const closePromoSheet = () => {
    setPendingFulfillment(null)
    dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel: null })
  }

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
    const problem = newCustomerProblem(newCustomerForm)
    if (problem) {
      setCustomerError(problem)
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
    // Cancelling the confirm leaves the (already queued) customer unselected: say so, so nobody re-adds them.
    requestSetCustomer(created, () => showToast('Pelanggan tersimpan, belum dipilih'))
    closeCustomerSheet()
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
      showToast('Promo tidak berlaku lagi (syarat barang berubah). Dihapus dari keranjang.')
      return
    }
    // Re-guard: a promo/code valid when picked can lapse while the cart sits open (hour/day
    // boundary) or fall below min_purchase (items removed). Drop ONLY what failed (B2) and keep the
    // rest; the cashier re-confirms a clean total. This keeps the server-side discount_warning rare.
    const guard = resolveConfirmGuard({
      state,
      discountCodes,
      promotions,
      ctx: {
        now: new Date(),
        outletId: authStore.outletId ?? '',
        timezone: outletTimezone,
        hasCustomer: state.selectedCustomer !== null,
        customerId: state.selectedCustomer?.id,
      },
    })
    if (guard.drops.length > 0) {
      for (const action of guard.actions) dispatch(action)
      showToast(guard.messages.join('\n'))
      return
    }
    if (guard.clearAll) {
      showToast('Promo/Kode Promo tidak berlaku lagi (tidak bisa digabung). Dihapus dari keranjang.')
      dispatch({ type: 'CLEAR_PROMOTIONS' })
      return
    }
    // C6: the payment is judged at tap time against the total NOW (never trimmed to fit): a stale plan is refused.
    const plan = planSaleTender({
      splitMode: state.splitMode, tenders: state.tenders, method: state.paymentMethod, amountInput: state.amountPaid,
      reference: state.tenderReference, due: derived.total, isCash: isCashId, labelOf: methodLabel,
    })
    if (!plan.ok) {
      showToast(plan.reason)
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
        const quote = buildReceiptQuote({
          cart: giveaway ? [...state.cart, giveaway] : state.cart, derived, tender: { amountPaid: plan.amountPaid, change: plan.change },
          refVersion: engine.referenceVersion(), tenders: snapshotTenders(plan, methodLabel),
        })
        quoteHolder.current = quote
        // C4b: each line carries its net share and promo group so a refund of this sale can be priced on the
        // tablet before it syncs. The server ignores both keys for money; null = whole-order refund only.
        const saleItems = withSaleLineData({
          cart: state.cart, appliedPromotions: state.appliedPromotions, appliedPromoCodes: state.appliedPromoCodes,
          discountType: state.appliedDiscountType, discountRunning: state.discountRunning, total: derived.total, knownPromotions: promotions,
          onError: (e) => { void reportErrors([{ source: 'runtime', kind: 'sale_line_data', action: `Hitung data refund per baris ${orderNo}`, message: e instanceof Error ? e.message : 'gagal', outletName: snapshot.outletName }]) },
        }) ?? state.cart
        // C6 D-62: a split sale reuses the uuid minted when split mode started, so a saved draft and the queued
        // sale share one idempotency key (a draft can never become a second sale).
        const queued = await engine.enqueue('order', {
        orderNumber: orderNo,
        items: saleItems,
        ...salePaymentFields(plan),
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
      }, state.splitMode && state.splitOrderUuid ? state.splitOrderUuid : undefined)
        // The draft goes right after the enqueue resolved, inside the gate; a kill in between leaves a draft whose
        // uuid is already queued, which the next start drops without a prompt.
        await splitDraft.clearForSale(queued.orderUuid)
        return queued
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
        paymentLabel: PAYMENT_LABELS[plan.paymentMethod] ?? plan.paymentMethod,
        customerName: state.selectedCustomer?.name ?? null,
        customerPhone: state.selectedCustomer?.phone ?? null,
        cashierName: user?.displayName ?? 'Kasir',
      })
      lastReceipt.current = receipt
      lastPayment.current = { paymentMethod: plan.paymentMethod, amountPaid: plan.amountPaid, change: plan.change }
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
      ...(orderReceiptTenders(o, settings.paymentMethods) ? { tenders: orderReceiptTenders(o, settings.paymentMethods) } : {}),
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

  /** What this tablet saw acknowledged for earlier per-line refunds of an order named by any of these ids. */
  const refundCacheFor = (ids: readonly string[]): RefundCache => ({ qtyByLine: engine.partialRefundedQty(ids), amount: engine.partialRefundedAmount(ids) })
  const refundIdsFor = (orderId: string): string[] =>
    [orderId, refundSale?.orderUuid, refundSale?.serverOrderId, saleUuidByServerId.get(orderId)].filter((k): k is string => !!k)

  const handleRefundConfirm = async (orderId: string, input: RefundConfirmInput) => {
    if (refundGate.current.isBusy()) return
    const lockedMsg = offlineLock()
    if (lockedMsg) {
      setRefundError(lockedMsg)
      return
    }
    setRefundError(null)
    // Defensive guards (the panel already hides the button): permission, an open synced shift, a valid
    // reason. The display snapshot is built here, once; nothing rewrites the payload after it is queued.
    // A refund may already be queued or done under the sale's uuid or its server id (the panel hides the button too);
    // D-44: while one refund of an order waits on this tablet, a second one is refused.
    const ids = refundIdsFor(orderId)
    const synced = engine.syncedRefundOrderIds()
    const queuedIds = engine.queuedRefundOrderIds()
    const queuedUuids = engine.queuedRefundSaleUuids()
    if (ids.some((k) => synced.has(k))) { setRefundError(REFUND_DONE); return }
    if (ids.some((k) => queuedIds.has(k) || queuedUuids.has(k))) { setRefundError(REFUND_QUEUED); return }
    const plan = planRefundSubmit({
      refundOrder, orderId, reason: input.reason, reasonCode: input.reasonCode, selection: input.selection, cache: refundCacheFor(ids), payoutMethod: input.payoutMethod, methods: settings.paymentMethods,
      canRefund: canRefund(user), shiftId: shift.currentShift?.id, sale: refundSale ?? undefined,
    })
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
    showToast('Refund diproses — stok dipulihkan saat terkirim')
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
  const handleBlindCount = (v: boolean) => { setBlindCount(v); localStorage.setItem('pos_blindCount', v ? '1' : '0') }

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
      // Mid-commit the checkout must stay put: closing it would expose the catalog while the order is enqueued.
      const layer = cashierBackLayer({
        isBusy: state.isProcessing || saleGate.current.isBusy(), confirmOpen: confirm !== null, pickerOpen: pendingFulfillment !== null,
        successOpen: state.isSuccessOpen, checkoutOpen: state.isCheckoutOpen, adjustmentOpen: !!state.activeAdjustment, cartTabActive: state.activeTab === 'cart',
      })
      if (layer === 'ignore-busy') return true
      if (layer === 'close-confirm') { confirm?.onCancel?.(); setConfirm(null); return true }
      if (heldOpen) { setHeldOpen(false); return true }
      if (profileCustomer) { setProfileCustomer(null); return true }
      if (showCustomerSheet) { closeCustomerSheet(); return true }
      if (lineBackRef.current?.()) return true
      if (variantBackRef.current?.()) return true
      if (showConnection) { setShowConnection(false); return true }
      if (showMenu) { setShowMenu(false); return true }
      if (showSettings) { setShowSettings(false); return true }
      if (showHistory) { setShowHistory(false); return true }
      if (showLocalReceipts) { setShowLocalReceipts(false); return true }
      if (showTransferHistory) { setShowTransferHistory(false); return true }
      if (showRequisitions) { if (!requisitionBackRef.current?.()) setShowRequisitions(false); return true }
      if (showRecap) { if (!recapBackRef.current?.()) setShowRecap(false); return true }
      if (refundOrder) { setRefundOrder(null); setRefundSale(null); return true }
      if (layer === 'close-picker') { setPendingFulfillment(null); return true }
      if (layer === 'close-success') { dispatch({ type: 'CLOSE_SUCCESS' }); return true }
      if (layer === 'close-checkout') {
        // D-63: Back is the same exit as Kembali, so entered payment lines ask first.
        if (state.splitMode && state.tenders.length > 0) {
          setConfirm({
            message: 'Hapus pembayaran yang sudah dimasukkan? Pastikan transaksi di mesin EDC/QRIS dibatalkan.',
            confirmLabel: 'Hapus', tone: 'danger', run: () => { setSaleError(null); dispatch({ type: 'CLOSE_CHECKOUT' }) },
          })
        } else dispatch({ type: 'CLOSE_CHECKOUT' })
        return true
      }
      if (layer === 'close-adjustment') { closePromoSheet(); return true }
      if (layer === 'cart-to-products') { dispatch({ type: 'SET_ACTIVE_TAB', tab: 'products' }); return true }
      // Nothing to navigate back to — still consume it. A POS must never be
      // closed/minimized by a stray Back press; only "Keluar" logs out.
      return true
    })
    return () => setBackHandler(null)
  }, [
    showConnection, showMenu, showSettings, showHistory, showLocalReceipts, showTransferHistory, showRequisitions, showRecap, refundOrder,
    state.isSuccessOpen, state.isCheckoutOpen, state.activeAdjustment, state.isProcessing, pendingFulfillment, confirm,
    state.activeTab, profileCustomer, showCustomerSheet, heldOpen,
    // D-63: the Back handler asks before dropping entered payment lines, so it must see them.
    state.splitMode, state.tenders,
  ])

  if (!user) return null

  // Sales made on this tablet (A41): read only while a surface that needs them is open (the list is parsed from storage).
  const localReceipts: LocalReceipt[] = showHistory || showLocalReceipts ? engine.localReceipts() : []
  const saleUuidByServerId = new Map(localReceipts.flatMap((r): [string, string][] => (r.serverOrderId ? [[r.serverOrderId, r.orderUuid]] : [])))

  const attached = state.selectedCustomer
  const customerChip = (
    <CustomerChip
      customer={state.selectedCustomer}
      loyaltyEnabled={loyalty.enabled && hasFeature('loyalty')}
      earnedPoints={derived.earnedPoints}
      rewards={chipRewards({ loyaltyEnabled: loyalty.enabled && hasFeature('loyalty'), online: offlineData.isOnline, loading: rewardsLoading, count: rewardsAvailableCount(rewards, state.cart) })}
      onOpenProfile={hasFeature('customerProfile') && attached ? () => openProfile(attached) : null}
      onOpenPicker={() => setShowCustomerSheet(true)}
      onRelease={() => requestSetCustomer(null)}
    />
  )

  return (
    <div className="h-screen flex flex-col bg-paper-0 overflow-hidden">
      {/* Header — brand logo, then the active-shift chip and the live
          online/offline indicator in the same row (moved up out of the old
          shift bar / the drawer footer). */}
      <header className="bg-white border-b border-paper-2 min-h-14 px-3 py-1 flex items-center justify-between gap-2 flex-shrink-0 safe-top">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <img src={brand.logo} alt={`${brand.displayName} POS`} className="h-7 w-auto object-contain flex-shrink-0" />
          {/* Read-only: the terminal's outlet is fixed (A04); change it only via Lepas terminal. */}
          {outletLabel && <span className="text-[0.9375rem] font-semibold text-ink-700 truncate flex-shrink min-w-0" title="Outlet terminal">{outletLabel}</span>}
          <ShiftBar
            currentShift={shift.currentShift} isLoading={shift.isLoadingShift}
            isOpening={shift.isOpeningShift}
            onOpenShift={shift.openShift}
            isOnline={offlineData.isOnline} canOpen={shift.canOpenShift}
            error={shift.shiftError}
            onRequestClose={() => { setCloseIntent(true); setShowRecap(true) }}
            promptOpen={shiftPrompt} onPromptConsumed={() => setShiftPrompt(false)}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <SyncStatus
            open={showConnection} onOpenChange={setShowConnection}
            otaUpdate={ota.state.pending && {
              version: ota.state.pending.version, blockedBy: otaRenderBlock, applying: ota.state.applying, error: ota.state.error,
              onRestart: handleOtaRestart,
            }}
            isOnline={offlineData.isOnline} pendingCount={offlineData.pendingCount}
            review={offlineData.review} stuck={offlineData.stuck} accountProblem={offlineData.accountProblem} wall={offlineData.wall}
            offlineCap={offlineCap} isResyncing={offlineData.isResyncing} autoUpdate={offlineData.autoPullAvailable}
            onResync={() => void offlineData.resync()} onFlush={offlineData.flush}
            onRetryOne={(k) => { offlineData.retryOne(k).then(() => parked.onRequeued([k])).catch(() => showToast('Gagal menyetel ulang transaksi. Coba lagi.')) }} onAcknowledge={parked.onAcknowledge} acknowledged={parked.acked}
            onRetryFailed={() => { offlineData.retryFailed().then(() => parked.onRequeued(offlineData.review.map((r) => r.idempotencyKey))).catch(() => showToast('Gagal menyetel ulang antrean. Coba lagi.')) }} onExportLog={() => { void handleExportLog() }}
          />
          <button type="button"
            onClick={() => setShowMenu(true)}
            className="touch relative inline-flex items-center justify-center rounded-control text-ink-700 active:bg-paper-1"
            title="Menu" aria-label="Menu"
          >
            <IconMenu size={24} />
            {offlineData.review.length > 0 ? (
              <span className="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold leading-4 text-center" aria-label={`${offlineData.review.length} perlu ditinjau`}>{offlineData.review.length}</span>
            ) : (offlineData.pendingCount > 0 || inbound.length > 0) && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-danger" />
            )}
          </button>
        </div>
      </header>

      {offlineCap.level === 'locked' && (
        <Banner tone="danger" message={OFFLINE_LOCKED_MESSAGE} action={{ label: 'Cek koneksi', onClick: () => void offlineData.resync() }} />
      )}

      {parked.banner && (
        <Banner tone="danger" message={parkedSaleMessage(parked.banner.ref)}
          action={{ label: 'Lihat', onClick: () => { parked.dismissBanner(parked.banner!.key); setShowConnection(true) } }}
          onDismiss={() => parked.dismissBanner(parked.banner!.key)} />
      )}

      {splitDraft.pending && !state.isCheckoutOpen && !state.isSuccessOpen && (
        <Banner tone="warn"
          message={`Ada pembayaran terpisah belum selesai: ${draftChargedSummary(splitDraft.pending, isCashId, methodLabel)} sudah dicatat`}
          action={{ label: 'Lanjutkan', onClick: () => (state.cart.length === 0 ? splitDraft.restore() : setConfirm({ message: 'Ganti keranjang saat ini? Isinya tidak tersimpan kecuali kamu simpan dulu.', confirmLabel: 'Ganti', tone: 'primary', run: () => splitDraft.restore() })) }}
          onDismiss={() => setConfirm({
            message: 'Hapus pembayaran terpisah yang belum selesai? Pastikan transaksi di mesin EDC/QRIS dibatalkan.',
            confirmLabel: 'Hapus', tone: 'danger', run: () => splitDraft.discard(),
          })} />
      )}

      {ota.state.pending && otaBannerDismissed !== ota.state.pending.version && (
        <Banner tone="info" message="Versi baru siap, mulai ulang saat kasir kosong"
          action={{ label: 'Lihat', onClick: () => setShowConnection(true) }}
          onDismiss={() => setOtaBannerDismissed(ota.state.pending!.version)} />
      )}

      {shift.shiftError && (
        <div role="alert" className="bg-danger-solid text-white text-sm font-semibold px-4 py-2 flex items-center justify-between gap-3 flex-shrink-0">
          <span>{shift.shiftError}</span>
          <button type="button" onClick={shift.clearShiftError} className="text-xs underline flex-shrink-0">Tutup</button>
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Mobile tab bar — cart tab only appears when the cart has items. */}
        <div className={`sm:hidden absolute bottom-0 left-0 right-0 bg-white border-t border-paper-2 z-10 safe-bottom-tab ${derived.totalCartItems > 0 ? 'flex' : 'hidden'}`}>
          {(['products', 'cart'] as const).map((tab) => (
            <button type="button" key={tab} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab })}
              className={`flex-1 py-3 text-xs font-bold relative ${state.activeTab === tab ? 'text-ink-900 border-t-2 border-ink-900' : 'text-ink-500'}`}>
              {tab === 'products' ? 'Produk' : 'Keranjang'}
              {tab === 'cart' && derived.totalCartItems > 0 && (
                <span className="absolute top-1.5 right-8 bg-ink-900 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {derived.totalCartItems}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Product panel */}
        <div className={`flex-1 min-w-0 overflow-hidden sm:block ${state.activeTab === 'cart' ? 'hidden' : 'block'}`}>
          {derived.totalCartItems === 0 && customerChip}
          {derived.totalCartItems === 0 && heldOrders.held.length > 0 && (
            <div className="px-3 pt-2">
              <Button variant="secondary" onClick={() => heldOrders.setOpen(true)} className="min-h-11">
                Pesanan tersimpan ({heldOrders.held.length})
              </Button>
            </div>
          )}
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
            variantBackRef={variantBackRef}
          />
        </div>

        {/* Cart panel — only mounts once the cart has items (dynamic). */}
        {derived.totalCartItems > 0 && (
          <div className={`w-full sm:w-80 lg:w-[486px] flex-shrink-0 flex-col sm:flex pb-20 sm:pb-0 ${state.activeTab === 'products' ? 'hidden sm:flex' : 'flex'}`}>
            <Cart
              cart={state.cart} giveaway={giveaway} derived={derived} settings={settings}
              customerSlot={customerChip}
              pendingSync={offlineData.pendingCount > 0}
              products={displayProducts}
              onRemove={cartActions.removeItem} onSetQty={cartActions.setQty}
              onSwitchSize={handleSwitchSize} lineBackRef={lineBackRef}
              heldCount={heldOrders.held.length} onOpenHeld={() => heldOrders.setOpen(true)}
              onClear={() => setConfirm({ message: 'Kosongkan keranjang? Pelanggan, promo dan catatan ikut terhapus.', confirmLabel: 'Kosongkan', tone: 'danger', run: cartActions.clearCart })}
              onCheckout={handleCheckout}
              onOpenAdjustment={(panel) => { setPendingFulfillment(null); dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel }) }}
              discountRunning={state.discountRunning} discountType={state.appliedDiscountType}
              surchargeRunning={state.surchargeRunning}
              orderNotes={state.orderNotes}
              appliedPromotions={state.appliedPromotions}
              appliedPromoCodes={state.appliedPromoCodes}
              onRemovePromotion={(id) => dispatch({ type: 'REMOVE_PROMOTION', id })}
              onRemovePromoCode={(code) => dispatch({ type: 'REMOVE_PROMO_CODE', code })}
              onClearDiscount={() => dispatch({ type: 'CLEAR_DISCOUNT' })}
              wallRaised={false}
            />
          </div>
        )}
      </div>

      <CustomerPicker
        open={showCustomerSheet} onClose={closeCustomerSheet}
        customers={customers}
        recent={showCustomerSheet && hasFeature('customerProfile') ? recentCustomers(getKnownCustomers().recent(10), customers) : []}
        customerSearch={state.customerSearch} isAddingCustomer={isAddingCustomer}
        newCustomerForm={newCustomerForm} isSaving={isSavingCustomer}
        onSearchChange={(q) => dispatch({ type: 'SET_CUSTOMER_SEARCH', search: q })}
        onSelect={(c) => { getKnownCustomers().remember(c); closeCustomerSheet(); requestSetCustomer(c) }}
        onToggleAdding={() => { setIsAddingCustomer((v) => !v); setCustomerError(null) }}
        onNewFormChange={(f, v) => setNewCustomerForm((prev) => ({ ...prev, [f]: v }))}
        onSaveNew={() => void handleAddCustomer()}
        onAddNewFromSearch={handleAddNewFromSearch}
        errorText={customerError}
        loyaltyEnabled={loyalty.enabled}
        isSearching={lookupPending} lookupError={lookupError}
        awaitingSearch={awaitingSearch(state.customerSearch, offlineData.isOnline, lookupRequest?.text ?? null)}
        onSubmitSearch={() => setLookupRequest((prev) => ({ text: state.customerSearch.trim(), n: (prev?.n ?? 0) + 1 }))}
        isOnline={offlineData.isOnline}
        onOpenProfile={hasFeature('customerProfile') ? openProfile : undefined}
      />
      <CustomerProfileSheet
        customer={profileCustomer} status={customerProfile.status} profile={customerProfile.profile}
        localOrders={profileCustomer ? localHistoryFor(engine.localReceiptsForCustomer(profileCustomer.id)) : []}
        loyaltyEnabled={loyalty.enabled && hasFeature('loyalty')}
        rewardsCount={profileCustomer && profileCustomer.id === state.selectedCustomer?.id && offlineData.isOnline && !rewardsLoading ? rewardsAvailableCount(rewards, state.cart) : null}
        attached={profileCustomer !== null && profileCustomer.id === state.selectedCustomer?.id}
        now={profileNow}
        onRepeat={(lines) => addPlanned(planRepeat(lines, displayProducts))}
        onAddOne={(item) => addPlanned(planOne(item, displayProducts))}
        onSelect={(c) => { getKnownCustomers().remember(c); setProfileCustomer(null); closeCustomerSheet(); requestSetCustomer(c) }}
        onClose={() => setProfileCustomer(null)}
      />

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
        pendingFulfillment={pendingFulfillment}
        stockFor={(pid, size) => stockFor(displayProducts, pid, size)}
        stockProducts={displayProducts}
        onBxgyConfirm={handleBxgyRewardConfirm}
        onBundleConfirm={handleBundlePickerConfirm}
        onCancelPicker={() => setPendingFulfillment(null)}
        onClosePromo={closePromoSheet}
      />

      <CheckoutPanel
        isOpen={state.isCheckoutOpen} isProcessing={state.isProcessing}
        derived={derived} totalRows={checkoutRows} settings={settings} paymentMethod={state.paymentMethod}
        amountPaid={state.amountPaid} selectedCustomer={state.selectedCustomer}
        orderNotes={state.orderNotes}
        salesmen={salesmen} selectedSalesmanId={state.selectedSalesman?.id ?? null}
        onSelectSalesman={(s) => dispatch({ type: 'SET_SALESMAN', salesman: s })}
        loyaltyEnabled={loyalty.enabled}
        customerPoints={state.selectedCustomer?.points ?? 0}
        rewards={rewardsLoading ? [] : rewards}
        rewardsLoading={rewardsLoading}
        stockProducts={displayProducts}
        pickedRewards={pickedRewards}
        onPickReward={handlePickReward}
        onClearReward={handleClearReward}
        pointsToRedeem={state.pointsToRedeem}
        onPointsRedeemedChange={(p) => dispatch({ type: 'SET_POINTS_REDEEMED', points: p })}
        onPaymentMethodChange={(m) => dispatch({ type: 'SET_PAYMENT_METHOD', method: m })}
        onAmountPaidChange={(a) => dispatch({ type: 'SET_AMOUNT_PAID', amount: a })}
        tenderReference={state.tenderReference}
        onTenderReferenceChange={(r) => dispatch({ type: 'SET_TENDER_REFERENCE', reference: r })}
        splitMode={state.splitMode} tenders={state.tenders}
        onSplitStart={() => {
          // An unrestored draft holds a charge made on the EDC: finish or delete it before starting another split.
          if (splitDraft.pending) { showToast('Selesaikan atau hapus dulu pembayaran terpisah yang belum selesai'); return }
          dispatch({ type: 'SPLIT_START', orderUuid: uuid() })
        }}
        onSplitCancel={() => dispatch({ type: 'SPLIT_CANCEL' })}
        onTenderAdd={(line) => dispatch({ type: 'TENDER_ADD', line, due: derived.total, isCash: isCashId })}
        onTenderRemove={(index) => dispatch({ type: 'TENDER_REMOVE', index })}
        onConfirm={() => void handleConfirmPayment()}
        saveError={saleError}
        onClose={() => { setSaleError(null); dispatch({ type: 'CLOSE_CHECKOUT' }) }}
        allowNegativeStock={settings.allowNegativeStock ?? true}
        cartLines={state.cart}
        isOnline={offlineData.isOnline}
      />

      <ReceiptPreview
        isOpen={state.isSuccessOpen} orderId={state.lastOrderId} orderNumber={state.lastOrderNumber} items={state.cart} giveaway={giveaway}
        totalRows={receiptRows}
        paymentMethod={successPayment.paymentMethod}
        amountPaid={successPayment.amountPaid}
        change={successPayment.change}
        tenders={state.isSuccessOpen ? lastReceipt.current?.tenders : undefined}
        customerName={state.selectedCustomer?.name ?? null} cashierName={user.displayName}
        settings={settings} isPendingSync={offlineData.pendingCount > 0}
        orderState={state.isSuccessOpen ? orderStateFor(engine.localReceipts(), state.lastOrderId) : 'unknown'}
        onPairPrinter={() => openSettings('printer')}
        canReprint={printer.isPaired} printError={printError}
        onReprint={handleReprint}
        onClose={() => dispatch({ type: 'CLOSE_SUCCESS' })}
        onNewSale={() => dispatch({ type: 'RESET_SALE' })}
      />

      <HeldOrdersSheet
        open={heldOrders.open} onClose={() => heldOrders.setOpen(false)} held={heldOrders.held}
        canSave={heldOrders.hasCart} defaultName={heldOrders.suggestedName}
        onSave={heldOrders.save} onResume={heldOrders.resume} onDelete={heldOrders.remove}
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
        blindCount={blindCount}
        heldCount={heldOrders.held.length}
        backRef={recapBackRef}
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
        heldCount={heldOrders.held.length}
        onHeldOrders={() => heldOrders.setOpen(true)}
        onHistory={() => { setHistoryFocus(null); setShowHistory(true) }}
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
        canRequestStock={canRequestStock(user)}
        onRequisitions={() => setShowRequisitions(true)}
        inboundCount={inbound.length}
      />

      <OrderHistoryPanel
        key={historyFocus ? `focus:${historyFocus.orderId}:${historyFocus.nonce}` : 'plain'}
        focus={historyFocus}
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        onRefund={(o) => { setShowHistory(false); setRefundSale(null); setRefundOrder(o) }}
        onReprint={reprintOrder}
        canReprint={printer.isPaired}
        timezone={outletTimezone}
        shiftOpenedAt={shift.currentShift?.openedAt}
        paymentMethods={settings.paymentMethods}
        {...refundGateProps({ user, currentShift: shift.currentShift, queuedOrderIds: engine.queuedRefundOrderIds(), syncedRefundOrderIds: engine.syncedRefundOrderIds(), queuedSaleUuids: engine.queuedRefundSaleUuids(), serverIdToSaleUuid: saleUuidByServerId, refundCache: refundCacheFor })}
      />

      <LocalReceiptsPanel
        isOpen={showLocalReceipts}
        onClose={() => setShowLocalReceipts(false)}
        receipts={localReceipts}
        paymentMethods={settings.paymentMethods}
        canReprint={printer.isPaired}
        onReprint={reprintLocal}
        isOnline={offlineData.isOnline}
        onOpenInHistory={(r) => {
          if (!r.serverOrderId) return
          setHistoryFocus({ orderId: r.serverOrderId, orderNumber: r.orderNumber, capturedAt: r.capturedAt, nonce: Date.now() })
          setShowLocalReceipts(false)
          setShowHistory(true)
        }}
        onRefund={(r) => { setShowLocalReceipts(false); setRefundSale(localSaleRef(r)); setRefundOrder(localReceiptOrder(r, settings.paymentMethods)) }}
        {...refundGateProps({ user, currentShift: shift.currentShift, queuedOrderIds: engine.queuedRefundOrderIds(), syncedRefundOrderIds: engine.syncedRefundOrderIds(), queuedSaleUuids: engine.queuedRefundSaleUuids(), serverIdToSaleUuid: saleUuidByServerId, refundCache: refundCacheFor })}
      />

      <RefundDialog order={refundOrder} methods={settings.paymentMethods} cache={refundOrder ? refundCacheFor(refundIdsFor(refundOrder.id)) : undefined} isProcessing={isRefunding} error={refundError}
        onConfirm={(id, input) => { void handleRefundConfirm(id, input) }}
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

      {showRequisitions && (
        <RequisitionPanel
          onClose={() => setShowRequisitions(false)} backRef={requisitionBackRef}
          onOpenReceive={() => { setShowRequisitions(false); setShowReceive(true) }}
          isOnline={offlineData.isOnline} products={displayProducts} userId={user.id} outletId={authStore.outletId ?? ''} />
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

      <ConfirmDialog
        open={confirm !== null}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        tone={confirm?.tone}
        onCancel={dismissConfirm}
        onConfirm={() => { const run = confirm?.run; setConfirm(null); run?.() }}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] whitespace-pre-line text-center bg-gray-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg safe-bottom">
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
          blindCount={blindCount} onBlindCountChange={handleBlindCount}
          onClose={() => { setShowSettings(false); setSettingsSection(undefined) }}
        />
      )}
    </div>
  )
}
