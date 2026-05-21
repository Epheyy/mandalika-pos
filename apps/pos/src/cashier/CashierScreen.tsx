/**
 * Orchestrator — no business logic, composes leaf components.
 * Data from SyncEngine snapshot (offline-first); writes via engine.enqueue.
 */

import { useContext, useReducer, useRef, useState, useEffect } from 'react'
import type { components } from '@mandalika/api'
import type { ReceiptData } from '@mandalika/printer'
import { SyncContext } from './SyncProvider'
import { usePrinter } from '../printer'
import { setBackHandler } from '../native'
import { useAuth } from '../auth'
import { useOfflineData } from '../hooks/useOfflineData'
import { useShift } from '../hooks/useShift'
import { useCart } from '../hooks/useCart'
import { cashierReducer, CASHIER_INITIAL_STATE } from './state/cashierReducer'
import { ProductGrid } from './ProductGrid'
import { Cart } from './Cart'
import { CheckoutPanel } from './CheckoutPanel'
import { CustomerPicker } from './CustomerPicker'
import { AdjustmentDrawer } from './AdjustmentDrawer'
import { MenuDrawer } from './MenuDrawer'
import { ShiftBar } from './ShiftBar'
import { ReceiptPreview } from './ReceiptPreview'
import { RefundDialog } from './RefundDialog'
import { OrderHistoryPanel } from './OrderHistoryPanel'
import { ShiftRecapPanel } from './ShiftRecapPanel'
import { SyncStatus } from '../components/SyncStatus'
import { OutletSwitcher } from '../components/OutletSwitcher'
import { SettingsScreen, type SettingsSection } from '../screens/SettingsScreen'
import { localOrderRef } from './orderRef'
import { api } from '../api'
import logoGold from '../assets/logo-gold.png'

type FontSize = 'sm' | 'md' | 'lg'
type GridCols = 2 | 3 | 4 | 6
type Order = components['schemas']['Order']
type Customer = components['schemas']['Customer']

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
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Tunai', card: 'Kartu', transfer: 'Transfer', qris: 'QRIS',
}

const DEFAULT_LOYALTY: components['schemas']['LoyaltySettings'] = {
  enabled: true, tierEnabled: true, pointsPerThousand: 1, redemptionRate: 100,
}

export default function CashierScreen() {
  const { user, logout } = useAuth()
  const engine = useContext(SyncContext)!
  const offlineData = useOfflineData()
  const shift = useShift()
  const [state, dispatch] = useReducer(cashierReducer, CASHIER_INITIAL_STATE)

  // UI prefs
  const [fontSize, setFontSize] = useState<FontSize>('md')
  const [gridCols, setGridCols] = useState<GridCols>(4)
  const [defaultView, setDefaultView] = useState<'products' | 'cart'>('products')
  // Forced single-column "mobile" layout regardless of screen width (drawer
  // toggle "Ganti Ke Tampilan Mobile"). Persisted across reloads.
  const [forceMobile, setForceMobile] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // Which settings section to scroll to when opened from a drawer shortcut.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddingCustomer, setIsAddingCustomer] = useState(false)
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', phone: '', email: '' })
  const [localCustomers, setLocalCustomers] = useState<Customer[]>([])
  const [isSavingCustomer, setIsSavingCustomer] = useState(false)
  const [customerError, setCustomerError] = useState<string | null>(null)
  const [isValidatingCode, setIsValidatingCode] = useState(false)
  const [refundOrder, setRefundOrder] = useState<Order | null>(null)
  const [isRefunding, setIsRefunding] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showRecap, setShowRecap] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  // Raised when the cashier tries to sell with no open shift → forces the
  // ShiftBar open-shift modal (selling without a shift is not allowed).
  const [shiftPrompt, setShiftPrompt] = useState(false)
  // Raised when checkout is attempted with no customer (customer is required).
  const [customerRequired, setCustomerRequired] = useState(false)
  const printer = usePrinter()
  const lastReceipt = useRef<ReceiptData | null>(null)
  const [printError, setPrintError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    const fs = localStorage.getItem('pos_fontSize') as FontSize | null
    if (fs) setFontSize(fs)
    const gc = localStorage.getItem('pos_gridCols')
    if (gc) setGridCols(parseInt(gc) as GridCols)
    const dv = localStorage.getItem('pos_defaultView') as 'products' | 'cart' | null
    if (dv) { setDefaultView(dv); dispatch({ type: 'SET_ACTIVE_TAB', tab: dv }) }
    if (localStorage.getItem('pos_forceMobile') === '1') setForceMobile(true)
  }, [])

  const snapshot = engine.getSnapshot()
  const products = (snapshot.products ?? []).filter((p) => p.isActive)
  const categories = snapshot.categories ?? []
  // Customers created on this device this session aren't in the synced
  // snapshot yet (snapshot only refreshes on resync). Merge them in so the
  // cashier can immediately find/select them.
  const snapCustomers = snapshot.customers ?? []
  const customers = [
    ...localCustomers.filter(
      (lc) => !snapCustomers.some((sc) => sc.id === lc.id),
    ),
    ...snapCustomers,
  ]
  const salesmen = (snapshot.users ?? []).map((u) => ({ id: u.id, name: u.displayName }))
  const promotions = snapshot.promotions ?? []
  const discountCodes = snapshot.discountCodes ?? []
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

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const defaultMethod = (enabledMethods[0]?.id ?? 'cash') as 'cash' | 'card' | 'transfer' | 'qris'

  // A shift must be open before anything can be sold. Returns false (and
  // pops the open-shift modal) when there is no active shift.
  const ensureShift = (): boolean => {
    if (shift.currentShift) return true
    setShiftPrompt(true)
    return false
  }

  const handleProductTap = (
    product: components['schemas']['Product'],
    variantQtys: Record<string, number>,
  ) => {
    if (!ensureShift()) return
    cartActions.addVariants(product, variantQtys)
  }

  const handleCheckout = () => {
    // Non-blocking sync: a pending backoffice update never blocks a sale —
    // the order queues and flushes; the SyncStatus chip nudges the cashier.
    if (!ensureShift()) return
    if (!state.selectedCustomer) {
      // Customer is mandatory — surface the picker instead of checkout.
      setCustomerRequired(true)
      setIsAddingCustomer(false)
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'products' })
      return
    }
    setCustomerRequired(false)
    dispatch({ type: 'OPEN_CHECKOUT', defaultMethod })
  }

  const handleAddCustomer = async () => {
    if (!newCustomerForm.name.trim() || !newCustomerForm.phone.trim()) {
      setCustomerError('Nama dan telepon wajib diisi')
      return
    }
    setIsSavingCustomer(true)
    setCustomerError(null)
    const name = newCustomerForm.name.trim()
    const phone = newCustomerForm.phone.trim()
    const email = newCustomerForm.email.trim()
    try {
      // POST /customers returns only `{ id }`, not the full record. Build the
      // Customer locally from the form + returned id so it reads immediately
      // everywhere (cart, receipt, and the synced order's customerName) —
      // before the background resync brings the server copy.
      const r = await api.request<{ data: { id: string } }>(
        'POST', '/api/v1/customers',
        { name, phone, email: email || undefined },
      )
      const created: components['schemas']['Customer'] = {
        id: r.data.id,
        name,
        phone,
        email: email || null,
        points: 0,
        totalSpent: 0,
        visitCount: 0,
        createdAt: new Date().toISOString(),
      }
      setLocalCustomers((prev) => [created, ...prev])
      dispatch({ type: 'SET_CUSTOMER', customer: created })
      setIsAddingCustomer(false)
      setCustomerRequired(false)
      setNewCustomerForm({ name: '', phone: '', email: '' })
      // Converge the synced snapshot in the background so it persists
      // across reloads / shows on other devices.
      void offlineData.resync().catch(() => {})
    } catch (e: unknown) {
      setCustomerError(e instanceof Error ? e.message : 'Gagal menyimpan pelanggan')
    } finally { setIsSavingCustomer(false) }
  }

  // Unified search → add-new: numeric query becomes the phone, otherwise the
  // name. Switches the picker into add mode with the field prefilled.
  const handleAddNewFromSearch = (q: string) => {
    const isPhone = /^[+0-9][0-9\s-]*$/.test(q)
    setNewCustomerForm({
      name: isPhone ? '' : q,
      phone: isPhone ? q.replace(/[\s-]/g, '') : '',
      email: '',
    })
    setCustomerError(null)
    setIsAddingCustomer(true)
    dispatch({ type: 'SET_CUSTOMER_SEARCH', search: '' })
  }

  const handleApplyPromoCode = async () => {
    const code = state.promoCodeInput.trim().toUpperCase()
    if (!code) return
    setIsValidatingCode(true)
    try {
      const dc = discountCodes.find((d) => d.code.toUpperCase() === code && d.isActive)
      if (!dc) return
      const today = new Date().toISOString().slice(0, 10)
      if (dc.startDate && dc.startDate > today) return
      if (dc.endDate && dc.endDate < today) return
      if (dc.usageLimit && dc.usageCount >= dc.usageLimit) return
      if (dc.minPurchase && derived.subtotal < dc.minPurchase) return
      dispatch({ type: 'APPLY_PROMO_CODE', code: { code: dc.code, value: dc.value, type: dc.type } })
    } finally { setIsValidatingCode(false) }
  }

  const handleConfirmPayment = () => {
    if (state.isProcessing) return
    dispatch({ type: 'SET_PROCESSING', processing: true })
    try {
      const { orderUuid } = engine.enqueue('order', {
        items: state.cart,
        paymentMethod: state.paymentMethod,
        amountPaid: state.paymentMethod === 'cash' ? derived.paid : derived.total,
        customerId: state.selectedCustomer?.id ?? null,
        customerName: state.selectedCustomer?.name ?? null,
        salesmanId: state.selectedSalesman?.id ?? null,
        salesmanName: state.selectedSalesman?.name ?? null,
        discountType: state.discountRunning > 0 ? state.appliedDiscountType : null,
        discountValue: state.discountRunning > 0 ? state.discountRunning : null,
        surchargeValue: state.surchargeRunning > 0 ? state.surchargeRunning : null,
        surchargeType: state.surchargeRunning > 0 ? state.appliedSurchargeType : null,
        discountCode: state.appliedPromoCode?.code ?? null,
        promotionId: state.appliedPromotion?.id ?? null,
        pointsRedeemed: derived.redeemedPoints > 0 ? derived.redeemedPoints : null,
        notes: state.orderNotes.trim() || null,
        shiftId: shift.currentShift?.id ?? null,
      })
      const receipt: ReceiptData = {
        orderRef: localOrderRef(orderUuid),
        pending: true, // server assigns the canonical number at sync (§5)
        dateTime: new Date(),
        lines: state.cart.map((i) => ({
          name: i.productName,
          variant: i.variantSize || undefined,
          qty: i.quantity,
          unitPrice: i.price,
          amount: i.subtotal,
        })),
        subtotal: derived.subtotal,
        discountAmount: derived.discountAmount,
        taxAmount: derived.taxAmount,
        total: derived.total,
        paymentLabel: PAYMENT_LABELS[state.paymentMethod] ?? state.paymentMethod,
        amountPaid: state.paymentMethod === 'cash' ? derived.paid : derived.total,
        change: state.paymentMethod === 'cash' ? derived.change : 0,
        customerName: state.selectedCustomer?.name ?? null,
        customerPhone: state.selectedCustomer?.phone ?? null,
        cashierName: user?.displayName ?? 'Kasir',
      }
      lastReceipt.current = receipt
      setPrintError(null)
      dispatch({ type: 'ORDER_SUCCESS', orderId: orderUuid })
      // Local BLE print — works offline, independent of sync (§6).
      // Auto-print on every successful sale when a printer is paired.
      if (printer.isPaired) {
        printer
          .print(receipt, settings.receipt)
          .catch((e: unknown) =>
            setPrintError(e instanceof Error ? e.message : 'Gagal mencetak'),
          )
      }
    } catch { dispatch({ type: 'SET_PROCESSING', processing: false }) }
  }

  const handleReprint = () => {
    if (!lastReceipt.current) return
    setPrintError(null)
    printer
      .print(lastReceipt.current, settings.receipt)
      .catch((e: unknown) =>
        setPrintError(e instanceof Error ? e.message : 'Gagal mencetak'),
      )
  }

  const handleRefundConfirm = (orderId: string, reason: string) => {
    setIsRefunding(true)
    try {
      engine.enqueue('refund', { orderId, reason })
      setRefundOrder(null)
      showToast('Refund diproses — stok dipulihkan saat sinkronisasi')
    } finally { setIsRefunding(false) }
  }

  const handleFontSize = (s: FontSize) => { setFontSize(s); localStorage.setItem('pos_fontSize', s) }
  const handleGridCols = (c: GridCols) => { setGridCols(c); localStorage.setItem('pos_gridCols', String(c)) }
  const handleDefaultView = (v: 'products' | 'cart') => { setDefaultView(v); localStorage.setItem('pos_defaultView', v) }

  // Drawer shortcut: open Settings scrolled to a section.
  const openSettings = (section?: SettingsSection) => { setSettingsSection(section); setShowSettings(true) }

  // Drawer shortcut "Ganti Tampilan Default": flip the startup view and persist.
  const toggleDefaultView = () => {
    const next = defaultView === 'products' ? 'cart' : 'products'
    handleDefaultView(next)
    showToast(`Tampilan default: ${next === 'products' ? 'Produk' : 'Keranjang'}`)
  }

  // Drawer shortcut "Ganti Ke Tampilan Mobile/Tablet": force single-column.
  const toggleForceMobile = () => {
    setForceMobile((v) => {
      const next = !v
      localStorage.setItem('pos_forceMobile', next ? '1' : '0')
      showToast(next ? 'Tampilan mobile aktif' : 'Tampilan tablet aktif')
      return next
    })
  }

  // Android hardware Back: close the top-most surface instead of exiting.
  useEffect(() => {
    setBackHandler(() => {
      if (showMenu) { setShowMenu(false); return true }
      if (showSettings) { setShowSettings(false); return true }
      if (showHistory) { setShowHistory(false); return true }
      if (showRecap) { setShowRecap(false); return true }
      if (refundOrder) { setRefundOrder(null); return true }
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
    showMenu, showSettings, showHistory, showRecap, refundOrder,
    state.isSuccessOpen, state.isCheckoutOpen, state.activeAdjustment,
    state.activeTab,
  ])

  if (!user) return null

  const fontClass = fontSize === 'lg' ? 'text-base' : 'text-sm'

  return (
    <div className={`h-screen flex flex-col bg-gray-50 overflow-hidden ${fontClass}`}>
      {/* Header — brand logo, then the active-shift chip and the live
          online/offline indicator in the same row (moved up out of the old
          shift bar / the drawer footer). */}
      <header className="bg-white border-b border-gray-100 px-3 py-2 flex items-center justify-between gap-2 flex-shrink-0 safe-top">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <img src={logoGold} alt="Mandalika POS" className="h-6 w-auto object-contain flex-shrink-0" />
          <div className="flex-shrink min-w-0">
            <OutletSwitcher user={user} onResync={offlineData.resync} />
          </div>
          <ShiftBar
            currentShift={shift.currentShift} isLoading={shift.isLoadingShift}
            isOpening={shift.isOpeningShift} isClosing={shift.isClosingShift}
            onOpenShift={shift.openShift} onCloseShift={shift.closeShift}
            promptOpen={shiftPrompt} onPromptConsumed={() => setShiftPrompt(false)}
          />
          <div
            className="flex items-center gap-1 flex-shrink-0"
            title={offlineData.isOnline ? 'Online' : 'Offline'}
          >
            <span className={`w-2 h-2 rounded-full ${offlineData.isOnline ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className={`text-[11px] font-semibold hidden sm:inline ${offlineData.isOnline ? 'text-green-600' : 'text-gray-400'}`}>
              {offlineData.isOnline ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <SyncStatus
            isOnline={offlineData.isOnline} pendingCount={offlineData.pendingCount}
            failed={offlineData.failed} wall={offlineData.wall}
            isResyncing={offlineData.isResyncing}
            onResync={() => void offlineData.resync()} onFlush={offlineData.flush}
            onRetryFailed={offlineData.retryFailed}
          />
          <button
            onClick={() => setShowMenu(true)}
            className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="Menu" aria-label="Menu"
          >
            <svg className="w-5 h-5 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
            {offlineData.pendingCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Mobile tab bar — cart tab only appears when the cart has items. */}
        <div className={`${forceMobile ? '' : 'sm:hidden'} absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-10 safe-bottom-tab ${derived.totalCartItems > 0 ? 'flex' : 'hidden'}`}>
          {(['products', 'cart'] as const).map((tab) => (
            <button key={tab} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab })}
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
        <div className={`flex-1 min-w-0 overflow-hidden ${forceMobile ? '' : 'sm:block'} ${state.activeTab === 'cart' ? 'hidden' : 'block'}`}>
          <CustomerPicker
            customers={customers} selectedCustomer={state.selectedCustomer}
            customerSearch={state.customerSearch} isAddingCustomer={isAddingCustomer}
            newCustomerForm={newCustomerForm} isSaving={isSavingCustomer}
            onSearchChange={(q) => dispatch({ type: 'SET_CUSTOMER_SEARCH', search: q })}
            onSelect={(c) => { dispatch({ type: 'SET_CUSTOMER', customer: c }); setCustomerRequired(false) }}
            onClear={() => dispatch({ type: 'SET_CUSTOMER', customer: null })}
            onToggleAdding={() => { setIsAddingCustomer((v) => !v); setCustomerError(null) }}
            onNewFormChange={(f, v) => setNewCustomerForm((prev) => ({ ...prev, [f]: v }))}
            onSaveNew={() => void handleAddCustomer()}
            earnedPoints={derived.earnedPoints}
            required={customerRequired}
            onAddNewFromSearch={handleAddNewFromSearch}
            errorText={customerError}
            loyaltyEnabled={loyalty.enabled}
          />
          <ProductGrid
            products={products} categories={categories}
            selectedCategoryId={selectedCategoryId} searchQuery={searchQuery}
            showFavouritesOnly={showFavouritesOnly} gridCols={gridCols}
            onProductTap={handleProductTap}
            onCategoryChange={setSelectedCategoryId} onSearchChange={setSearchQuery}
            onToggleFavourites={() => setShowFavouritesOnly((v) => !v)} isLoading={false}
          />
        </div>

        {/* Cart panel — only mounts once the cart has items (dynamic). */}
        {derived.totalCartItems > 0 && (
          <div className={`w-full ${forceMobile ? '' : 'sm:w-80'} flex-shrink-0 flex flex-col ${forceMobile ? '' : 'sm:flex'} pb-20 ${forceMobile ? '' : 'sm:pb-0'} ${state.activeTab === 'products' ? (forceMobile ? 'hidden' : 'hidden sm:flex') : 'flex'}`}>
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
              appliedPromoLabel={state.appliedPromotion?.name ?? state.appliedPromoCode?.code ?? null}
              onClearDiscount={() => dispatch({ type: 'CLEAR_DISCOUNT' })}
              onClearPromo={() => dispatch({ type: 'CLEAR_PROMOTIONS' })}
              loyaltyEnabled={loyalty.enabled}
              wallRaised={false}
            />
          </div>
        )}
      </div>

      {/* Floating panels */}
      <AdjustmentDrawer
        state={state} dispatch={dispatch} promotions={promotions} discountCodes={discountCodes}
        subtotal={derived.subtotal} isValidatingCode={isValidatingCode}
        onApplyPromoCode={() => void handleApplyPromoCode()}
        onApplyDiscount={cartActions.applyDiscount}
        onApplySurcharge={cartActions.applySurcharge}
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
        pointsToRedeem={state.pointsToRedeem}
        onPointsRedeemedChange={(p) => dispatch({ type: 'SET_POINTS_REDEEMED', points: p })}
        onPaymentMethodChange={(m) => dispatch({ type: 'SET_PAYMENT_METHOD', method: m })}
        onAmountPaidChange={(a) => dispatch({ type: 'SET_AMOUNT_PAID', amount: a })}
        onConfirm={handleConfirmPayment}
        onClose={() => dispatch({ type: 'CLOSE_CHECKOUT' })}
        discountAmount={derived.discountAmount} taxAmount={derived.taxAmount}
      />

      <ReceiptPreview
        isOpen={state.isSuccessOpen} orderId={state.lastOrderId} items={state.cart}
        total={derived.total} discountAmount={derived.discountAmount} taxAmount={derived.taxAmount}
        paymentMethod={state.paymentMethod}
        amountPaid={state.paymentMethod === 'cash' ? derived.paid : derived.total}
        change={state.paymentMethod === 'cash' ? derived.change : 0}
        customerName={state.selectedCustomer?.name ?? null} cashierName={user.displayName}
        settings={settings} isPendingSync={offlineData.pendingCount > 0}
        canReprint={printer.isPaired} printError={printError}
        onReprint={handleReprint}
        onClose={() => dispatch({ type: 'CLOSE_SUCCESS' })}
        onNewSale={() => dispatch({ type: 'RESET_SALE' })}
      />

      <ShiftRecapPanel
        isOpen={showRecap}
        onClose={() => setShowRecap(false)}
        paymentMethods={settings.paymentMethods}
        userName={user.displayName}
        userRole={user.role}
        onOpenShift={shift.openShift}
        onCloseShift={shift.closeShift}
        isOpeningShift={shift.isOpeningShift}
        isClosingShift={shift.isClosingShift}
      />

      <MenuDrawer
        open={showMenu}
        onClose={() => setShowMenu(false)}
        user={user}
        shiftActive={!!shift.currentShift}
        pendingSync={offlineData.pendingCount > 0}
        isSyncing={offlineData.isResyncing}
        forceMobile={forceMobile}
        lastSyncedLabel={offlineData.lastSyncedAt
          ? new Date(offlineData.lastSyncedAt).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
          : null}
        onTakeOrder={() => setShowMenu(false)}
        onHistory={() => setShowHistory(true)}
        onRecap={() => setShowRecap(true)}
        onCashFlow={() => openSettings('cashflow')}
        onSync={() => void offlineData.resync()}
        onPrintSettings={() => openSettings('printer')}
        onProductDisplay={() => openSettings('display')}
        onDefaultView={toggleDefaultView}
        onToggleMobile={toggleForceMobile}
        onBackOffice={() => window.open('https://mandalika-pos.pages.dev', '_system')}
        onLogout={logout}
      />

      <OrderHistoryPanel
        isOpen={showHistory}
        onClose={() => setShowHistory(false)}
        onRefund={(o) => { setShowHistory(false); setRefundOrder(o) }}
      />

      <RefundDialog order={refundOrder} isProcessing={isRefunding}
        onConfirm={handleRefundConfirm} onClose={() => setRefundOrder(null)} />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-gray-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg safe-bottom">
          {toast}
        </div>
      )}

      {showSettings && (
        <SettingsScreen
          settings={settings} currentShift={shift.currentShift}
          fontSize={fontSize} gridCols={gridCols} defaultView={defaultView}
          onFontSizeChange={handleFontSize} onGridColsChange={handleGridCols}
          onDefaultViewChange={handleDefaultView}
          onResync={offlineData.resync} isResyncing={offlineData.isResyncing}
          initialSection={settingsSection}
          onClose={() => { setShowSettings(false); setSettingsSection(undefined) }}
        />
      )}
    </div>
  )
}
