/**
 * Orchestrator — no business logic, composes leaf components.
 * Data from SyncEngine snapshot (offline-first); writes via engine.enqueue.
 */

import { useContext, useReducer, useRef, useState, useEffect } from 'react'
import type { components } from '@mandalika/api'
import type { ReceiptData } from '@mandalika/printer'
import { SyncContext } from './SyncProvider'
import { usePrinter } from '../printer'
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
import { ShiftBar } from './ShiftBar'
import { ReceiptPreview } from './ReceiptPreview'
import { RefundDialog } from './RefundDialog'
import { SyncWall } from '../components/SyncWall'
import { OutletSwitcher } from '../components/OutletSwitcher'
import { SettingsScreen } from '../screens/SettingsScreen'
import { api } from '../api'

type FontSize = 'sm' | 'md' | 'lg'
type GridCols = 2 | 3 | 4 | 6
type Order = components['schemas']['Order']

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
  const [showSettings, setShowSettings] = useState(false)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddingCustomer, setIsAddingCustomer] = useState(false)
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', phone: '', email: '' })
  const [isSavingCustomer, setIsSavingCustomer] = useState(false)
  const [isValidatingCode, setIsValidatingCode] = useState(false)
  const [refundOrder, setRefundOrder] = useState<Order | null>(null)
  const [isRefunding, setIsRefunding] = useState(false)
  const printer = usePrinter()
  const lastReceipt = useRef<ReceiptData | null>(null)
  const [printError, setPrintError] = useState<string | null>(null)

  useEffect(() => {
    const fs = localStorage.getItem('pos_fontSize') as FontSize | null
    if (fs) setFontSize(fs)
    const gc = localStorage.getItem('pos_gridCols')
    if (gc) setGridCols(parseInt(gc) as GridCols)
    const dv = localStorage.getItem('pos_defaultView') as 'products' | 'cart' | null
    if (dv) { setDefaultView(dv); dispatch({ type: 'SET_ACTIVE_TAB', tab: dv }) }
  }, [])

  const snapshot = engine.getSnapshot()
  const products = (snapshot.products ?? []).filter((p) => p.isActive)
  const categories = snapshot.categories ?? []
  const customers = snapshot.customers ?? []
  const promotions = snapshot.promotions ?? []
  const discountCodes = snapshot.discountCodes ?? []
  const settings = snapshot.appSettings ?? DEFAULT_SETTINGS
  const loyalty = snapshot.loyaltySettings ?? DEFAULT_LOYALTY

  const { actions: cartActions, derived } = useCart({ state, dispatch, settings, loyalty })

  const enabledMethods = settings.paymentMethods.filter((m) => m.isEnabled)
  const defaultMethod = (enabledMethods[0]?.id ?? 'cash') as 'cash' | 'card' | 'transfer' | 'qris'

  const handleAddCustomer = async () => {
    if (!newCustomerForm.name.trim() || !newCustomerForm.phone.trim()) return
    setIsSavingCustomer(true)
    try {
      const r = await api.request<{ data: components['schemas']['Customer'] }>(
        'POST', '/api/v1/customers',
        { name: newCustomerForm.name.trim(), phone: newCustomerForm.phone.trim(), email: newCustomerForm.email.trim() || undefined },
      )
      dispatch({ type: 'SET_CUSTOMER', customer: r.data })
      setIsAddingCustomer(false)
      setNewCustomerForm({ name: '', phone: '', email: '' })
    } catch { /* silent */ } finally { setIsSavingCustomer(false) }
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
        discountType: state.discountRunning > 0 ? state.discountType : null,
        discountValue: state.discountRunning > 0 ? state.discountRunning : null,
        surchargeValue: state.surchargeRunning > 0 ? state.surchargeRunning : null,
        discountCode: state.appliedPromoCode?.code ?? null,
        promotionId: state.appliedPromotion?.id ?? null,
        notes: state.orderNotes.trim() || null,
        shiftId: shift.currentShift?.id ?? null,
      })
      const receipt: ReceiptData = {
        orderRef: orderUuid.slice(0, 8).toUpperCase(),
        pending: true, // server assigns the canonical number at sync (§5)
        dateTime: new Date(),
        lines: state.cart.map((i) => ({
          name: `${i.productName} ${i.variantSize}`.trim(),
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
      if (printer.isPaired && settings.receipt.autoPrint) {
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
    try { engine.enqueue('refund', { orderId, reason }); setRefundOrder(null) }
    finally { setIsRefunding(false) }
  }

  const handleFontSize = (s: FontSize) => { setFontSize(s); localStorage.setItem('pos_fontSize', s) }
  const handleGridCols = (c: GridCols) => { setGridCols(c); localStorage.setItem('pos_gridCols', String(c)) }
  const handleDefaultView = (v: 'products' | 'cart') => { setDefaultView(v); localStorage.setItem('pos_defaultView', v) }

  if (!user) return null

  const fontClass = fontSize === 'lg' ? 'text-base' : 'text-sm'

  return (
    <div className={`h-screen flex flex-col bg-gray-50 overflow-hidden ${fontClass}`}>
      <SyncWall
        wall={offlineData.wall} isResyncing={offlineData.isResyncing}
        pendingCount={offlineData.pendingCount} isOnline={offlineData.isOnline}
        lastSyncedAt={offlineData.lastSyncedAt} onResync={offlineData.resync} onFlush={offlineData.flush}
      />

      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-4 py-2 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-black text-gray-900 text-sm">Mandalika POS</span>
          <OutletSwitcher user={user} onResync={offlineData.resync} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 hidden sm:inline">{user.displayName}</span>
          <button onClick={() => setShowSettings(true)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="Pengaturan">⚙</button>
          <button onClick={logout} className="px-2 py-1 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg font-semibold">Keluar</button>
        </div>
      </header>

      <ShiftBar
        currentShift={shift.currentShift} isLoading={shift.isLoadingShift}
        isOpening={shift.isOpeningShift} isClosing={shift.isClosingShift}
        onOpenShift={shift.openShift} onCloseShift={shift.closeShift}
      />

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Mobile tab bar */}
        <div className="sm:hidden absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-10">
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
        <div className={`flex-1 min-w-0 overflow-hidden sm:block ${state.activeTab === 'cart' ? 'hidden' : 'block'}`}>
          <CustomerPicker
            customers={customers} selectedCustomer={state.selectedCustomer}
            customerSearch={state.customerSearch} isAddingCustomer={isAddingCustomer}
            newCustomerForm={newCustomerForm} isSaving={isSavingCustomer}
            onSearchChange={(q) => dispatch({ type: 'SET_CUSTOMER_SEARCH', search: q })}
            onSelect={(c) => dispatch({ type: 'SET_CUSTOMER', customer: c })}
            onClear={() => dispatch({ type: 'SET_CUSTOMER', customer: null })}
            onToggleAdding={() => setIsAddingCustomer((v) => !v)}
            onNewFormChange={(f, v) => setNewCustomerForm((prev) => ({ ...prev, [f]: v }))}
            onSaveNew={() => void handleAddCustomer()}
            earnedPoints={derived.earnedPoints}
          />
          <ProductGrid
            products={products} categories={categories}
            selectedCategoryId={selectedCategoryId} searchQuery={searchQuery}
            showFavouritesOnly={showFavouritesOnly} gridCols={gridCols}
            onProductTap={(p) => {
              if (p.variants.length === 1) cartActions.addVariants(p, { [p.variants[0].size]: 1 })
            }}
            onCategoryChange={setSelectedCategoryId} onSearchChange={setSearchQuery}
            onToggleFavourites={() => setShowFavouritesOnly((v) => !v)} isLoading={false}
          />
        </div>

        {/* Cart panel */}
        <div className={`w-full sm:w-80 flex-shrink-0 flex flex-col sm:flex ${state.activeTab === 'products' ? 'hidden sm:flex' : 'flex'}`}>
          <Cart
            cart={state.cart} derived={derived} settings={settings}
            pendingSync={offlineData.pendingCount > 0}
            onRemove={cartActions.removeItem} onSetQty={cartActions.setQty}
            onClear={cartActions.clearCart}
            onCheckout={() => { if (!offlineData.wall.raised) dispatch({ type: 'OPEN_CHECKOUT', defaultMethod }) }}
            onOpenAdjustment={(panel) => dispatch({ type: 'SET_ACTIVE_ADJUSTMENT', panel })}
            discountRunning={state.discountRunning} surchargeRunning={state.surchargeRunning}
            orderNotes={state.orderNotes}
            appliedPromoLabel={state.appliedPromotion?.name ?? state.appliedPromoCode?.code ?? null}
            wallRaised={offlineData.wall.raised}
          />
        </div>
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

      <RefundDialog order={refundOrder} isProcessing={isRefunding}
        onConfirm={handleRefundConfirm} onClose={() => setRefundOrder(null)} />

      {showSettings && (
        <SettingsScreen
          settings={settings} currentShift={shift.currentShift}
          fontSize={fontSize} gridCols={gridCols} defaultView={defaultView}
          onFontSizeChange={handleFontSize} onGridColsChange={handleGridCols}
          onDefaultViewChange={handleDefaultView}
          onResync={offlineData.resync} isResyncing={offlineData.isResyncing}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
