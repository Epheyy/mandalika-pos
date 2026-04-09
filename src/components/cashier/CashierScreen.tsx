import { useState, useEffect, useRef } from 'react'
import type { AppUser, Product, Category, CartItem, Order, Customer, LoyaltySettings, AppSettings, Promotion } from '../../types'
import { PaymentMethod, OrderStatus } from '../../types'
import { db } from '../../firebase'
import {
  collection, onSnapshot, addDoc, doc, getDoc,
  updateDoc, query, orderBy, where, getDocs
} from 'firebase/firestore'
import { BRAND } from '../../config/brand'
import {
  Search, ShoppingCart, LogOut, Package, Settings, X, CheckCircle,
  Banknote, CreditCard, Smartphone, ArrowLeftRight, History,
  ChevronDown, ChevronUp, User, Tag, Heart,
  UserPlus, Plus, Minus, Loader2, RotateCcw, Calendar, MoreHorizontal, ClipboardList, TrendingUp, Menu, ChevronRight
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

interface Props { appUser: AppUser; onLogout: () => void }

// ── Order number: MND-{6 digits} ──
function generateOrderNumber(): string {
  return `MND-${Math.floor(Math.random() * 900000 + 100000)}`
}

const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: true, tierEnabled: true, pointsPerThousand: 1, redemptionRate: 100,
}
const DEFAULT_SETTINGS: AppSettings = {
  taxEnabled: true, taxRate: 11, roundingEnabled: false, roundingType: 'none',
  paymentMethods: [
    { id: 'cash',     label: 'Tunai',    isEnabled: true },
    { id: 'card',     label: 'Kartu',    isEnabled: true },
    { id: 'qris',     label: 'QRIS',     isEnabled: true },
    { id: 'transfer', label: 'Transfer', isEnabled: true },
  ],
  receipt: { headerText: '', footerText: '', showTax: true, showCashier: true },
  autoOpenShift: false,
}

// ─────────────────────────────────────────────────────────────
export default function CashierScreen({ appUser, onLogout }: Props) {
  // ── Data ──────────────────────────────────────────────────
  const [products,   setProducts]   = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [customers,  setCustomers]  = useState<Customer[]>([])
  const [allUsers,   setAllUsers]   = useState<AppUser[]>([])
  const [loyalty,    setLoyalty]    = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  const [settings,   setSettings]   = useState<AppSettings>(DEFAULT_SETTINGS)
  const [isLoadingProducts, setIsLoadingProducts] = useState(true)

  // ── Product Grid ──────────────────────────────────────────
  const [searchQuery,        setSearchQuery]        = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)

  // ── Variant Pop-up ────────────────────────────────────────
  const [selectedProductForCart, setSelectedProductForCart] = useState<Product | null>(null)
  const [variantQtys,            setVariantQtys]            = useState<Record<string, number>>({})

  // ── Cart ──────────────────────────────────────────────────
  const [cart, setCart] = useState<CartItem[]>([])

  // ── Customer ──────────────────────────────────────────────
  const [selectedCustomer,      setSelectedCustomer]      = useState<Customer | null>(null)
  const [customerSearch,        setCustomerSearch]        = useState('')
  const [showCustomerDropdown,  setShowCustomerDropdown]  = useState(false)
  const [isAddingCustomer,      setIsAddingCustomer]      = useState(false)
  const [newCustomerForm,       setNewCustomerForm]       = useState({ name: '', phone: '', email: '' })
  const [isSavingCustomer,      setIsSavingCustomer]      = useState(false)
  const customerRef = useRef<HTMLDivElement>(null)

  // ── Adjustments panel (notes / discount / surcharge / promo) ─
  const [activeAdjustment, setActiveAdjustment] = useState<'notes' | 'discount' | 'promo' | null>(null)
  const [orderNotes,        setOrderNotes]        = useState('')
  const [discountType,      setDiscountType]      = useState<'percentage' | 'fixed'>('fixed')
  const [discountRunning,   setDiscountRunning]   = useState(0)   // reduces total
  const [surchargeRunning,  setSurchargeRunning]  = useState(0)   // increases total
  const [adjustInputStr,    setAdjustInputStr]    = useState('')  // shared input

  // ── Left nav sidebar ─────────────────────────────────────
  const [isNavOpen,         setIsNavOpen]         = useState(false)
  // ── Settings modal + Adjustments menu ───────────────────
  const [isSettingsOpen,    setIsSettingsOpen]    = useState(false)
  const [isShiftRecapOpen,  setIsShiftRecapOpen]  = useState(false)
  const [shiftOrders,       setShiftOrders]       = useState<Order[]>([])
  const [isLoadingShift,    setIsLoadingShift]    = useState(false)
  const [showAdjustMenu,    setShowAdjustMenu]    = useState(false)
  // ── Variant modal promo dropdown ────────────────────────
  const [variantPromoOpen,  setVariantPromoOpen]  = useState(false)
  const [appliedPromoCode,  setAppliedPromoCode]  = useState<{
    code: string; value: number; type: 'percentage' | 'fixed'
  } | null>(null)
  // promotions from backoffice
  const [promotions,        setPromotions]        = useState<Promotion[]>([])
  const [appliedPromotion,  setAppliedPromotion]  = useState<Promotion | null>(null)

  // ── Checkout ──────────────────────────────────────────────
  const [isCheckoutOpen,  setIsCheckoutOpen]  = useState(false)
  const [isSuccessOpen,   setIsSuccessOpen]   = useState(false)
  const [lastOrder,       setLastOrder]       = useState<Order | null>(null)
  const [isProcessing,    setIsProcessing]    = useState(false)
  const [paymentMethod,   setPaymentMethod]   = useState<PaymentMethod>(PaymentMethod.CASH)
  const [amountPaid,      setAmountPaid]      = useState('')
  const [selectedSalesman,setSelectedSalesman]= useState<AppUser | null>(null)

  // ── History ───────────────────────────────────────────────
  const [isHistoryOpen,      setIsHistoryOpen]      = useState(false)
  const [historyOrders,      setHistoryOrders]      = useState<Order[]>([])
  const [historyDateFrom,    setHistoryDateFrom]    = useState(format(new Date(), 'yyyy-MM-dd'))
  const [historyDateTo,      setHistoryDateTo]      = useState(format(new Date(), 'yyyy-MM-dd'))
  const [historyExpanded,    setHistoryExpanded]    = useState<string | null>(null)
  const [isLoadingHistory,   setIsLoadingHistory]   = useState(false)
  const [historyRefundId,    setHistoryRefundId]    = useState<string | null>(null)
  const [historyRefundNote,  setHistoryRefundNote]  = useState('')
  const [isRefundingHistory, setIsRefundingHistory] = useState(false)
  const [historySearch,      setHistorySearch]      = useState('')

  // ── Firestore subscriptions ───────────────────────────────
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'products'), s => {
      setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive))
      setIsLoadingProducts(false)
    })
    const u2 = onSnapshot(collection(db, 'categories'), s => {
      const cats = s.docs.map(d => ({ id: d.id, ...d.data() } as Category))
      setCategories(cats)
      setSelectedCategoryId(prev => prev ?? (cats[0]?.id ?? null))
    })
    const u3 = onSnapshot(collection(db, 'customers'), s =>
      setCustomers(s.docs.map(d => ({ id: d.id, ...d.data() } as Customer))))
    const u4 = onSnapshot(collection(db, 'users'), s =>
      setAllUsers(s.docs.map(d => ({ id: d.id, ...d.data() } as AppUser))))
    const u5 = onSnapshot(doc(db, 'settings', 'loyalty'), s => {
      if (s.exists()) setLoyalty(s.data() as LoyaltySettings)
    })
    const u6 = onSnapshot(doc(db, 'settings', 'app'), s => {
      if (s.exists()) setSettings({ ...DEFAULT_SETTINGS, ...s.data() as AppSettings })
    })
    const u7 = onSnapshot(collection(db, 'promotions'), s =>
      setPromotions(s.docs.map(d => ({ id: d.id, ...d.data() } as Promotion))))
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u7() }
  }, [])

  // ── History subscription (when modal open / dates change) ─
  useEffect(() => {
    if (!isHistoryOpen) return
    setIsLoadingHistory(true)

    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'))
    const unsub = onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as Order))
      const filtered = all.filter(o => {
        const d = o.createdAt.slice(0, 10)
        return d >= historyDateFrom && d <= historyDateTo
      })
      setHistoryOrders(filtered)
      setIsLoadingHistory(false)
    })

    return () => unsub()
  }, [isHistoryOpen, historyDateFrom, historyDateTo])

  // ── Click outside → close customer dropdown ───────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerRef.current && !customerRef.current.contains(e.target as Node))
        setShowCustomerDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Close adjust menu on outside click ──────────────────
  const adjustMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showAdjustMenu) return
    const handler = (e: MouseEvent) => {
      if (adjustMenuRef.current && adjustMenuRef.current.contains(e.target as Node)) return
      setShowAdjustMenu(false)
    }
    // Use 'mousedown' but only close if target is OUTSIDE the menu
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAdjustMenu])

  // ── Computed ──────────────────────────────────────────────
  const filteredProducts = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat    = !selectedCategoryId || p.categoryId === selectedCategoryId
    const matchFav    = !showFavouritesOnly || p.isFavourite
    return matchSearch && matchCat && matchFav
  })

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0)

  const manualDiscountAmount = discountRunning > 0
    ? discountType === 'percentage'
      ? Math.round(subtotal * (discountRunning / 100))
      : Math.min(discountRunning, subtotal)
    : 0

  const surchargeAmount = surchargeRunning > 0
    ? discountType === 'percentage'
      ? Math.round(subtotal * (surchargeRunning / 100))
      : surchargeRunning
    : 0

  // Promotion discount — supports percentage, fixed, bogo
  const calcPromotionDiscount = (promo: Promotion, items: CartItem[], sub: number): number => {
    const matchingItems = promo.applicableProductIds && promo.applicableProductIds.length > 0
      ? items.filter(i => promo.applicableProductIds!.includes(i.productId))
      : items
    const matchingSubtotal = matchingItems.reduce((s, i) => s + i.subtotal, 0)
    if (matchingItems.length === 0 && promo.applicableProductIds && promo.applicableProductIds.length > 0) return 0
    if (promo.type === 'percentage') return Math.round((matchingItems.length > 0 ? matchingSubtotal : sub) * (promo.value / 100))
    if (promo.type === 'fixed')      return Math.min(promo.value, sub)
    if (promo.type === 'bogo') {
      const prices = matchingItems.flatMap(i => Array.from({ length: i.quantity }, () => i.price))
      prices.sort((a, b) => a - b)
      return prices.length >= 2 ? prices[0] : 0
    }
    return 0
  }

  const promoDiscountAmount = appliedPromotion
    ? calcPromotionDiscount(appliedPromotion, cart, subtotal)
    : appliedPromoCode
      ? appliedPromoCode.type === 'percentage'
        ? Math.round(subtotal * (appliedPromoCode.value / 100))
        : Math.min(appliedPromoCode.value, subtotal)
      : 0

  const discountAmount  = Math.min(manualDiscountAmount + promoDiscountAmount, subtotal)
  const taxableAmount   = subtotal - discountAmount
  const taxAmount       = settings.taxEnabled ? Math.round(taxableAmount * (settings.taxRate / 100)) : 0
  let total             = taxableAmount + taxAmount + surchargeAmount
  if (settings.roundingEnabled) {
    const roundTo = settings.roundingType === 'nearest_1000' ? 1000
      : settings.roundingType === 'nearest_500' ? 500 : 1
    total = Math.round(total / roundTo) * roundTo
  }
  const paid               = parseFloat(amountPaid.replace(/\./g, '')) || 0
  const change             = Math.max(0, paid - total)
  const totalCartItems     = cart.reduce((s, i) => s + i.quantity, 0)
  const enabledPaymentMethods = settings.paymentMethods.filter(p => p.isEnabled)

  const filteredCustomers = customerSearch.length >= 2
    ? customers
        .filter(c =>
          c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
          c.phone.includes(customerSearch))
        .slice(0, 5)
    : []

  const earnedPoints = loyalty.enabled && selectedCustomer
    ? Math.floor(total / 1000) * loyalty.pointsPerThousand
    : 0

  const getTier = (spent: number) =>
    spent >= 5000000 ? 'Platinum'
    : spent >= 2000000 ? 'Gold'
    : spent >= 500000 ? 'Silver'
    : 'Member'

  // ── Date range helpers ────────────────────────────────────
  const handleHistoryDateChange = (field: 'from' | 'to', value: string) => {
    if (field === 'from') {
      const diff = Math.ceil(
        (new Date(historyDateTo).getTime() - new Date(value).getTime()) / 86400000
      )
      if (diff < 0) setHistoryDateTo(value)
      else if (diff > 31) {
        const newTo = new Date(new Date(value).getTime() + 31 * 86400000)
        setHistoryDateTo(format(newTo, 'yyyy-MM-dd'))
      }
      setHistoryDateFrom(value)
    } else {
      const diff = Math.ceil(
        (new Date(value).getTime() - new Date(historyDateFrom).getTime()) / 86400000
      )
      if (diff > 31) { alert('Rentang maksimum 1 bulan (31 hari)'); return }
      if (diff < 0) setHistoryDateFrom(value)
      setHistoryDateTo(value)
    }
  }

  // ── Variant pop-up handlers ───────────────────────────────
  const handleProductTap = (product: Product) => {
    const qtys: Record<string, number> = {}
    product.variants.forEach(v => { qtys[v.size] = 0 })
    setVariantQtys(qtys)
    setVariantPromoOpen(false)
    setSelectedProductForCart(product)
  }

  const handleVariantQtyChange = (size: string, delta: number) => {
    if (!selectedProductForCart) return
    const variant = selectedProductForCart.variants.find(v => v.size === size)
    if (!variant) return
    setVariantQtys(prev => ({
      ...prev,
      [size]: Math.max(0, Math.min((prev[size] || 0) + delta, variant.stock)),
    }))
  }

  const handleConfirmVariants = () => {
    if (!selectedProductForCart) return
    const newCart = [...cart]
    selectedProductForCart.variants.forEach(variant => {
      const qty = variantQtys[variant.size] || 0
      if (qty === 0) return
      const effectivePrice = variant.price
      const existingIndex = newCart.findIndex(
        i => i.productId === selectedProductForCart.id && i.variantSize === variant.size
      )
      if (existingIndex >= 0) {
        newCart[existingIndex] = { ...newCart[existingIndex] }
        newCart[existingIndex].quantity += qty
        newCart[existingIndex].price    = effectivePrice
        newCart[existingIndex].subtotal = Math.round(newCart[existingIndex].quantity * effectivePrice)
      } else {
        newCart.push({
          productId:   selectedProductForCart.id!,
          productName: selectedProductForCart.name,
          variantSize: variant.size,
          price:       effectivePrice,
          quantity:    qty,
          subtotal:    Math.round(effectivePrice * qty),
        })
      }
    })
    setCart(newCart)
    setSelectedProductForCart(null)
  }

  const totalVariantsSelected = Object.values(variantQtys).reduce((a, b) => a + b, 0)

  // ── Customer helpers ──────────────────────────────────────
  const handleAddNewCustomer = async () => {
    if (!newCustomerForm.name.trim() || !newCustomerForm.phone.trim()) {
      alert('Nama dan telepon wajib diisi')
      return
    }
    setIsSavingCustomer(true)
    try {
      const newCustomer = {
        name:       newCustomerForm.name.trim(),
        phone:      newCustomerForm.phone.trim(),
        email:      newCustomerForm.email.trim(),
        points:     0,
        totalSpent: 0,
        visitCount: 0,
        createdAt:  new Date().toISOString(),
      }
      const ref = await addDoc(collection(db, 'customers'), newCustomer)
      setSelectedCustomer({ id: ref.id, ...newCustomer })
      setIsAddingCustomer(false)
      setNewCustomerForm({ name: '', phone: '', email: '' })
      setCustomerSearch('')
    } catch { alert('Gagal menambahkan pelanggan.') }
    finally { setIsSavingCustomer(false) }
  }

  // ── Favourite toggle ──────────────────────────────────────
  const toggleFavourite = async (product: Product) => {
    if (!product.id) return
    await updateDoc(doc(db, 'products', product.id), { isFavourite: !product.isFavourite })
  }

  // ── Discount / Surcharge helpers ─────────────────────────
  // "-" applies discount (reduces total), "+" applies surcharge (increases total)
  const applyDiscount = () => {
    const val = parseFloat(adjustInputStr) || 0
    if (val <= 0) return
    setDiscountRunning(prev => prev + val)
    setAdjustInputStr('')
  }
  const applySurcharge = () => {
    const val = parseFloat(adjustInputStr) || 0
    if (val <= 0) return
    setSurchargeRunning(prev => prev + val)
    setAdjustInputStr('')
  }

  // ── History refund ────────────────────────────────────────
  const handleHistoryRefund = async () => {
    if (!historyRefundId || !historyRefundNote.trim()) {
      alert('Alasan refund wajib diisi')
      return
    }
    setIsRefundingHistory(true)
    try {
      const order = historyOrders.find(o => o.id === historyRefundId)
      if (!order) return

      await updateDoc(doc(db, 'orders', historyRefundId), {
        status:      OrderStatus.REFUNDED,
        refundReason: historyRefundNote.trim(),
        refundedAt:  new Date().toISOString(),
      })

      for (const item of order.items) {
        const productSnap = await getDoc(doc(db, 'products', item.productId))
        if (productSnap.exists()) {
          const pd = productSnap.data() as Product
          await updateDoc(doc(db, 'products', item.productId), {
            variants: pd.variants.map(v =>
              v.size === item.variantSize
                ? { ...v, stock: v.stock + item.quantity }
                : v
            ),
          })
        }
      }

      setHistoryRefundId(null)
      setHistoryRefundNote('')
      setHistoryExpanded(null)
    } catch { alert('Gagal memproses refund.') }
    finally { setIsRefundingHistory(false) }
  }

  // ── Open checkout ──────────────────────────────────────────
  const openCheckout = () => {
    setPaymentMethod(enabledPaymentMethods[0]?.id as PaymentMethod || PaymentMethod.CASH)
    setAmountPaid('')
    setSelectedSalesman(null)
    setIsCheckoutOpen(true)
  }

  // ── Confirm payment ───────────────────────────────────────
  const handleConfirmPayment = async () => {
    if (paymentMethod === PaymentMethod.CASH && paid < total) {
      alert('Jumlah bayar kurang!')
      return
    }
    setIsProcessing(true)
    try {
      const orderData = {
        orderNumber:  generateOrderNumber(),
        outletId:     'default',
        cashierId:    appUser.uid,
        cashierName:  appUser.displayName,
        items:        cart,
        subtotal,
        discountAmount,
        taxAmount,
        total,
        paymentMethod,
        amountPaid:   paymentMethod === PaymentMethod.CASH ? paid : total,
        change:       paymentMethod === PaymentMethod.CASH ? change : 0,
        status:       OrderStatus.COMPLETED,
        createdAt:    new Date().toISOString(),
        ...(selectedSalesman?.uid        && { salesmanId:   selectedSalesman.uid }),
        ...(selectedSalesman?.displayName && { salesmanName: selectedSalesman.displayName }),
        ...(selectedCustomer?.id          && { customerId:   selectedCustomer.id }),
        ...(selectedCustomer?.name        && { customerName: selectedCustomer.name }),
        ...(discountRunning > 0           && { discountType, discountValue: discountRunning }),
        ...(surchargeRunning > 0          && { surchargeType: discountType, surchargeValue: surchargeRunning, surchargeAmount }),
        ...(appliedPromoCode              && { discountCode: appliedPromoCode.code }),
        ...(orderNotes.trim()             && { notes: orderNotes.trim() }),
      }
      const order = orderData as Omit<Order, 'id'>
      const ref   = await addDoc(collection(db, 'orders'), order)

      // Decrement stock
      for (const item of cart) {
        const ps = await getDoc(doc(db, 'products', item.productId))
        if (ps.exists()) {
          const data = ps.data() as Product
          await updateDoc(doc(db, 'products', item.productId), {
            variants: data.variants.map(v =>
              v.size === item.variantSize
                ? { ...v, stock: Math.max(0, v.stock - item.quantity) }
                : v
            ),
          })
        }
      }

      // Update customer points
      if (selectedCustomer?.id) {
        await updateDoc(doc(db, 'customers', selectedCustomer.id), {
          totalSpent: selectedCustomer.totalSpent + total,
          visitCount: selectedCustomer.visitCount + 1,
          lastVisit:  new Date().toISOString(),
          points:     selectedCustomer.points + earnedPoints,
        })
      }

      // Increment promo usage
      if (appliedPromoCode) {
        const promoQ  = query(collection(db, 'discountCodes'), where('code', '==', appliedPromoCode.code))
        const promoSn = await getDocs(promoQ)
        if (!promoSn.empty) {
          await updateDoc(promoSn.docs[0].ref, {
            usageCount: (promoSn.docs[0].data().usageCount || 0) + 1,
          })
        }
      }

      setLastOrder({ id: ref.id, ...order })
      // Reset everything
      setCart([])
      setSelectedCustomer(null)
      setCustomerSearch('')
      setOrderNotes('')
      setDiscountRunning(0)
      setSurchargeRunning(0)
      setAdjustInputStr('')
      setAppliedPromoCode(null)
      setAppliedPromotion(null)
      setActiveAdjustment(null)
      setIsCheckoutOpen(false)
      setIsSuccessOpen(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`Gagal menyimpan transaksi.\n\nDetail: ${msg}`)
      console.error('Transaction error:', err)
    } finally { setIsProcessing(false) }
  }

  // ── Shift recap loader ───────────────────────────────────
  const openShiftRecap = async () => {
    setIsShiftRecapOpen(true)
    setIsLoadingShift(true)
    const today = new Date().toISOString().slice(0, 10)
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'))
    const snap = await getDocs(q)
    const todayOrders = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as Order))
      .filter(o => o.createdAt.slice(0, 10) === today)
    setShiftOrders(todayOrders)
    setIsLoadingShift(false)
  }

  // ── Clear cart ────────────────────────────────────────────
  const handleClearCart = () => {
    setCart([])
    setSelectedCustomer(null)
    setCustomerSearch('')
    setOrderNotes('')
    setDiscountRunning(0)
    setSurchargeRunning(0)
    setAdjustInputStr('')
    setAppliedPromoCode(null)
    setAppliedPromotion(null)
    setActiveAdjustment(null)
    setShowAdjustMenu(false)
  }


  const paymentIcons: Record<string, React.ReactNode> = {
    cash:     <Banknote      className="w-4 h-4" />,
    card:     <CreditCard    className="w-4 h-4" />,
    qris:     <Smartphone    className="w-4 h-4" />,
    transfer: <ArrowLeftRight className="w-4 h-4" />,
  }

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex bg-gray-50 overflow-hidden">

      {/* ══════════════════════════════════════════════════ */}
      {/* LEFT SIDEBAR — mirrors BackOffice aside            */}
      {/* ══════════════════════════════════════════════════ */}
      <>
        {/* Mobile overlay backdrop */}
        {isNavOpen && (
          <div className="fixed inset-0 bg-black/40 z-20 lg:hidden"
            onClick={() => setIsNavOpen(false)} />
        )}

        <aside className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-white border-r border-gray-200 flex flex-col transition-transform duration-300 ${isNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>

          {/* Sidebar header */}
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-8 flex items-center justify-center flex-shrink-0">
                <img src={BRAND.logoUrl} alt="Mandalika" className="w-full h-full object-contain" />
              </div>
              <div>
                <p className="text-sm font-black text-gray-900">{BRAND.name} POS</p>
                <p className="text-xs font-bold" style={{ color: BRAND.colors.primaryHex }}>Kasir</p>
              </div>
            </div>
            <button onClick={() => setIsNavOpen(false)} className="lg:hidden p-1 hover:bg-gray-100 rounded-lg">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          {/* Nav items */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {[
              {
                icon: <History className="w-4 h-4 flex-shrink-0" />,
                label: 'Riwayat Transaksi',
                sub: 'Cari & refund transaksi',
                onClick: () => { setIsNavOpen(false); setIsHistoryOpen(true); setHistorySearch('') },
                active: isHistoryOpen,
              },
              {
                icon: <ClipboardList className="w-4 h-4 flex-shrink-0" />,
                label: 'Rekap Shift',
                sub: 'Ringkasan hari ini',
                onClick: () => { setIsNavOpen(false); openShiftRecap() },
                active: isShiftRecapOpen,
              },
              {
                icon: <Settings className="w-4 h-4 flex-shrink-0" />,
                label: 'Pengaturan',
                sub: `Pajak · Pembulatan`,
                onClick: () => { setIsNavOpen(false); setIsSettingsOpen(true) },
                active: isSettingsOpen,
              },
            ].map(item => (
              <button key={item.label} onClick={item.onClick}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-bold transition-all text-left ${
                  item.active ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'}`}>
                {item.icon}
                <div className="flex-1 min-w-0">
                  <p className="leading-tight">{item.label}</p>
                  <p className={`text-[10px] font-normal truncate ${item.active ? 'text-indigo-200' : 'text-gray-400'}`}>{item.sub}</p>
                </div>
                {item.active && <ChevronRight className="w-3.5 h-3.5 opacity-70 flex-shrink-0" />}
              </button>
            ))}

            <div className="pt-3 border-t border-gray-100 mt-3">
              <button onClick={() => window.location.href = '/backoffice'}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-all text-left">
                <Settings className="w-4 h-4 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="leading-tight">Back Office</p>
                  <p className="text-[10px] font-normal text-gray-400 truncate">Produk, laporan, outlet</p>
                </div>
              </button>
            </div>
          </nav>

          {/* User + Logout */}
          <div className="p-3 border-t border-gray-100 space-y-2 flex-shrink-0">
            {/* Quick info strip */}
            <div className="px-3 py-2 bg-gray-50 rounded-xl space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-gray-400">Pajak</span>
                <span className="font-bold text-gray-700">{settings.taxEnabled ? `PPN ${settings.taxRate}%` : 'Nonaktif'}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-400">Pembulatan</span>
                <span className="font-bold text-gray-700">
                  {settings.roundingEnabled ? (settings.roundingType === 'nearest_1000' ? 'Rp 1.000' : 'Rp 500') : 'Nonaktif'}
                </span>
              </div>
            </div>
            {/* User row */}
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                {appUser.photoURL
                  ? <img src={appUser.photoURL} alt="" className="w-full h-full object-cover" />
                  : <span className="text-xs font-black text-indigo-600">{appUser.displayName.charAt(0)}</span>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{appUser.displayName}</p>
                <p className="text-xs text-gray-400 capitalize">{appUser.role}</p>
              </div>
            </div>
            <button onClick={onLogout}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all">
              <LogOut className="w-4 h-4" /> Keluar
            </button>
          </div>
        </aside>
      </>

      {/* ══════════════════════════════════════════════════ */}
      {/* RIGHT: main content (product + cart)               */}
      {/* ══════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

      {/* ── MAIN AREA ──────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: Product Grid ───────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Search + Filter bar */}
          <div className="bg-white border-b border-gray-200 px-4 py-3 space-y-3 flex-shrink-0">
            <div className="flex gap-2">
              {/* Mobile menu toggle relocated here */}
              <button onClick={() => setIsNavOpen(true)}
                className="lg:hidden p-2.5 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded-xl flex-shrink-0">
                <Menu className="w-5 h-5 text-gray-500" />
              </button>
              
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cari produk..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[16px] focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
              </div>
              <button
                onClick={() => setShowFavouritesOnly(!showFavouritesOnly)}
                className={`p-2.5 rounded-xl border-2 transition-all ${showFavouritesOnly
                  ? 'border-red-400 bg-red-50 text-red-500'
                  : 'border-gray-200 text-gray-400 hover:border-red-300'}`}
                title="Tampilkan favorit">
                <Heart className={`w-4 h-4 ${showFavouritesOnly ? 'fill-current' : ''}`} />
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategoryId(selectedCategoryId === cat.id ? null : cat.id!)}
                  className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${
                    selectedCategoryId === cat.id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Product grid */}
          <div className="flex-1 overflow-y-auto p-4">
            {isLoadingProducts ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className="bg-white rounded-2xl overflow-hidden animate-pulse">
                    <div className="w-full aspect-square bg-gray-200" />
                    <div className="p-2 space-y-1">
                      <div className="h-3 bg-gray-200 rounded w-4/5" />
                      <div className="h-3 bg-gray-200 rounded w-2/5" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
                <Package className="w-12 h-12" />
                <p className="font-bold">
                  {showFavouritesOnly ? 'Belum ada produk favorit' : 'Produk tidak ditemukan'}
                </p>
                {showFavouritesOnly && (
                  <p className="text-sm text-center">Klik ❤ di kartu produk untuk menambahkan ke favorit</p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {filteredProducts.map(product => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onSelect={handleProductTap}
                    onToggleFavourite={toggleFavourite}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Cart ──────────────────────────────── */}
        <div className="w-[280px] md:w-[300px] xl:w-80 bg-white border-l border-gray-200 flex flex-col flex-shrink-0">

          {/* Customer section */}
          <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex-shrink-0" ref={customerRef}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Pelanggan</p>
              {!selectedCustomer && !isAddingCustomer && (
                <button
                  onClick={() => {
                    setIsAddingCustomer(true)
                    setNewCustomerForm({ name: '', phone: '', email: '' })
                  }}
                  className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700">
                  <UserPlus className="w-3 h-3" /> Baru
                </button>
              )}
            </div>

            {isAddingCustomer ? (
              <div className="space-y-2">
                <p className="text-xs font-bold text-indigo-700">Tambah Pelanggan Baru</p>
                <input type="text"
                  value={newCustomerForm.name}
                  onChange={e => setNewCustomerForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Nama *"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="tel"
                  value={newCustomerForm.phone}
                  onChange={e => setNewCustomerForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="No. Telepon *"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <input type="email"
                  value={newCustomerForm.email}
                  onChange={e => setNewCustomerForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="Email (opsional)"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none" />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setIsAddingCustomer(false); setNewCustomerForm({ name: '', phone: '', email: '' }) }}
                    className="flex-1 py-1.5 border border-gray-200 text-gray-600 text-xs font-bold rounded-lg">
                    Batal
                  </button>
                  <button
                    onClick={handleAddNewCustomer}
                    disabled={isSavingCustomer}
                    className="flex-1 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1">
                    {isSavingCustomer ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Simpan
                  </button>
                </div>
              </div>
            ) : selectedCustomer ? (
              <div className="bg-indigo-50 rounded-xl p-3 flex items-start justify-between">
                <div>
                  <p className="font-bold text-indigo-900 text-sm">{selectedCustomer.name}</p>
                  <p className="text-xs text-indigo-600">{selectedCustomer.phone}</p>
                  {loyalty.enabled && (
                    <p className="text-xs text-indigo-500 mt-0.5">
                      Poin: {selectedCustomer.points.toLocaleString('id-ID')}
                      {earnedPoints > 0 && <span className="text-green-600 font-bold"> +{earnedPoints}</span>}
                    </p>
                  )}
                  {loyalty.tierEnabled && (
                    <p className="text-xs font-bold text-indigo-700">{getTier(selectedCustomer.totalSpent)}</p>
                  )}
                </div>
                <button
                  onClick={() => { setSelectedCustomer(null); setCustomerSearch('') }}
                  className="text-indigo-400 hover:text-red-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cari nama / no. telepon..."
                  value={customerSearch}
                  onChange={e => { setCustomerSearch(e.target.value); setShowCustomerDropdown(true) }}
                  onFocus={() => setShowCustomerDropdown(true)}
                  className="w-full pl-8 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {showCustomerDropdown && customerSearch.length >= 2 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                    {filteredCustomers.map(c => (
                      <button
                        key={c.id}
                        onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); setShowCustomerDropdown(false) }}
                        className="w-full px-3 py-2 text-left hover:bg-indigo-50 transition-all border-b border-gray-50 last:border-0">
                        <p className="text-sm font-bold text-gray-900">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.phone}</p>
                      </button>
                    ))}
                    {/* Inline "Add New" when no results */}
                    {filteredCustomers.length === 0 && (
                      <button
                        onClick={() => {
                          const isPhone = /^\d+$/.test(customerSearch)
                          setNewCustomerForm({
                            name:  isPhone ? '' : customerSearch,
                            phone: isPhone ? customerSearch : '',
                            email: '',
                          })
                          setIsAddingCustomer(true)
                          setShowCustomerDropdown(false)
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-indigo-50 flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                          <UserPlus className="w-3.5 h-3.5 text-indigo-600" />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-indigo-700">Tambah pelanggan baru</p>
                          <p className="text-xs text-gray-400">"{customerSearch}"</p>
                        </div>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Cart header */}
          <div className="px-4 py-2 border-b border-gray-100 flex-shrink-0">
            <h2 className="font-black text-gray-900 text-sm">
              Keranjang{' '}
              {cart.length > 0 && (
                <span className="text-indigo-600 ml-1">({totalCartItems})</span>
              )}
            </h2>
          </div>

          {/* Cart items */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-300">
                <ShoppingCart className="w-10 h-10" />
                <p className="text-sm font-medium">Keranjang kosong</p>
              </div>
            ) : (
              cart.map((item, index) => (
                <CartItemRow
                  key={`${item.productId}-${item.variantSize}`}
                  item={item}
                  index={index}
                  cart={cart}
                  setCart={setCart}
                />
              ))
            )}
          </div>

          {/* Adjustments toolbar + panels */}
          {cart.length > 0 && (
            <div className="flex-shrink-0 border-t border-gray-100">

              {/* ··· Adjustments menu */}
              <div className="relative px-3 py-2 flex items-center gap-2">
                {/* Active state badges */}
                <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
                  {orderNotes.trim() && (
                    <button onClick={() => setActiveAdjustment(prev => prev === 'notes' ? null : 'notes')}
                      className={`flex-shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-lg transition-all ${activeAdjustment === 'notes' ? 'bg-yellow-200 text-yellow-900' : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'}`}>
                      📝 Catatan
                    </button>
                  )}
                  {(discountRunning > 0 || surchargeRunning > 0) && (
                    <button onClick={() => setActiveAdjustment(prev => prev === 'discount' ? null : 'discount')}
                      className={`flex-shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-lg transition-all ${activeAdjustment === 'discount' ? 'bg-green-200 text-green-900' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
                      {discountRunning > 0 ? `-${BRAND.currency.format(manualDiscountAmount)}` : ''}
                      {discountRunning > 0 && surchargeRunning > 0 ? ' ' : ''}
                      {surchargeRunning > 0 ? `+${BRAND.currency.format(surchargeAmount)}` : ''}
                    </button>
                  )}
                  {appliedPromotion && (
                    <button onClick={() => setActiveAdjustment(prev => prev === 'promo' ? null : 'promo')}
                      className={`flex-shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-lg truncate max-w-[110px] transition-all ${activeAdjustment === 'promo' ? 'bg-indigo-200 text-indigo-900' : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'}`}>
                      🎁 {appliedPromotion.name}
                    </button>
                  )}
                </div>

                {/* ··· trigger */}
                <div ref={adjustMenuRef} className="relative flex-shrink-0">
                  <button
                    onClick={() => setShowAdjustMenu(v => !v)}
                    className={`w-8 h-8 flex items-center justify-center rounded-xl transition-all ${
                      showAdjustMenu ? 'bg-indigo-100 text-indigo-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}>
                    <MoreHorizontal className="w-4 h-4" />
                  </button>

                  {showAdjustMenu && (
                    <div className="absolute bottom-full right-0 mb-1 bg-white border border-gray-200 rounded-2xl shadow-xl z-30 overflow-hidden w-48">
                      {([
                        { id: 'notes'    as const, emoji: '📝', label: 'Catatan',            active: !!orderNotes.trim() },
                        { id: 'discount' as const, emoji: '🏷️', label: 'Diskon / Surcharge', active: discountRunning > 0 || surchargeRunning > 0 },
                        { id: 'promo'    as const, emoji: '🎁', label: 'Promosi',             active: !!appliedPromotion },
                      ] as const).map(item => (
                        <button
                          key={item.id}
                          onClick={() => {
                            setActiveAdjustment(prev => prev === item.id ? null : item.id)
                            setShowAdjustMenu(false)
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-left border-b border-gray-50 last:border-0 transition-all ${
                            activeAdjustment === item.id
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'text-gray-700 hover:bg-gray-50'}`}>
                          <span className="text-base">{item.emoji}</span>
                          <span className="flex-1">{item.label}</span>
                          {item.active && <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>



            </div>
          )}

          {/* Totals + Checkout */}
          <div className="border-t border-gray-100 p-4 space-y-2 flex-shrink-0">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Subtotal</span>
              <span className="font-bold">{BRAND.currency.format(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between text-xs text-green-600 font-bold">
                <span>Diskon</span>
                <span>-{BRAND.currency.format(discountAmount)}</span>
              </div>
            )}
            {surchargeAmount > 0 && (
              <div className="flex justify-between text-xs text-orange-600 font-bold">
                <span>Surcharge</span>
                <span>+{BRAND.currency.format(surchargeAmount)}</span>
              </div>
            )}
            {settings.taxEnabled && taxAmount > 0 && (
              <div className="flex justify-between text-xs text-gray-400">
                <span>PPN {settings.taxRate}%</span>
                <span>{BRAND.currency.format(taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-black text-gray-900 pt-1 border-t border-gray-100">
              <span>Total</span>
              <span className="text-indigo-600">{BRAND.currency.format(total)}</span>
            </div>
            <button
              onClick={openCheckout}
              disabled={cart.length === 0}
              className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all active:scale-[0.98] shadow-lg shadow-indigo-100 text-sm">
              {cart.length === 0 ? 'Keranjang Kosong' : `Bayar ${BRAND.currency.format(total)}`}
            </button>
            {cart.length > 0 && (
              <button
                onClick={handleClearCart}
                className="w-full py-1.5 text-xs font-bold text-gray-400 hover:text-red-500 transition-colors">
                Kosongkan
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════ */}
      {/* VARIANT POP-UP MODAL (landscape, 2-wide grid)        */}
      {/* ══════════════════════════════════════════════════ */}
      {selectedProductForCart && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh] overflow-hidden">

            {/* ── Header ── */}
            <div className="flex items-center gap-4 px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 overflow-hidden flex-shrink-0">
                {selectedProductForCart.imageUrl
                  ? <img src={selectedProductForCart.imageUrl} alt={selectedProductForCart.name}
                      className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center">
                      <Package className="w-6 h-6 text-gray-300" />
                    </div>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-gray-900 text-base leading-tight">{selectedProductForCart.name}</p>
                <p className="text-sm text-gray-400 mt-0.5">{selectedProductForCart.brand}</p>
                <p className="text-xs text-gray-300 mt-0.5">{selectedProductForCart.variants.length} varian tersedia</p>
              </div>
              <button
                onClick={() => setSelectedProductForCart(null)}
                className="p-2 hover:bg-gray-100 rounded-xl flex-shrink-0">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* ── Variant grid (2-wide, compact, qty on left) ── */}
            <div className="flex-1 overflow-y-auto px-5 pt-4 pb-2">
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Pilih Varian & Jumlah</p>
              <div className="grid grid-cols-2 gap-2">
                {selectedProductForCart.variants.map(variant => {
                  const qty   = variantQtys[variant.size] || 0
                  const isOut = variant.stock === 0
                  return (
                    <div key={variant.size}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 transition-all ${
                        isOut
                          ? 'border-gray-100 bg-gray-50 opacity-50'
                          : qty > 0
                            ? 'border-indigo-400 bg-indigo-50'
                            : 'border-gray-200 bg-white hover:border-gray-300'}`}>

                      {/* LEFT: info */}
                      <div className="flex-1 min-w-0">
                        <p className={`font-black text-xs leading-tight truncate ${qty > 0 ? 'text-indigo-800' : 'text-gray-800'}`}>
                          {variant.size}
                        </p>
                        {variant.sku && (
                          <p className="text-[9px] text-gray-400 font-mono truncate">{variant.sku}</p>
                        )}
                        <p className={`text-xs font-black mt-0.5 ${qty > 0 ? 'text-indigo-600' : 'text-gray-600'}`}>
                          {BRAND.currency.format(variant.price)}
                        </p>
                        <p className={`text-[10px] font-medium ${
                          isOut ? 'text-red-500' : variant.stock <= 5 ? 'text-orange-500' : 'text-gray-400'}`}>
                          {isOut ? 'Habis' : `Stok: ${variant.stock}`}
                        </p>
                      </div>

                      {/* RIGHT: qty controls */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleVariantQtyChange(variant.size, -1)}
                          disabled={qty === 0}
                          className={`w-7 h-7 rounded-lg border-2 font-black flex items-center justify-center transition-all ${
                            qty > 0
                              ? 'border-indigo-300 bg-white hover:bg-indigo-50 text-indigo-700'
                              : 'border-gray-200 bg-white text-gray-300 opacity-30'}`}>
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className={`text-sm font-black w-5 text-center ${qty > 0 ? 'text-indigo-700' : 'text-gray-300'}`}>
                          {qty}
                        </span>
                        <button
                          onClick={() => handleVariantQtyChange(variant.size, 1)}
                          disabled={isOut || qty >= variant.stock}
                          className="w-7 h-7 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black flex items-center justify-center transition-all">
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* ── Promotions dropdown ── */}
              {(() => {
                const now = new Date().toISOString().slice(0, 10)
                const activePromos = promotions.filter(p =>
                  p.isActive &&
                  !(p.startDate && p.startDate > now) &&
                  !(p.endDate   && p.endDate   < now)
                )
                if (activePromos.length === 0) return null
                return (
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <button
                      onClick={() => setVariantPromoOpen(v => !v)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border-2 transition-all text-sm font-bold ${
                        variantPromoOpen || appliedPromotion
                          ? 'border-indigo-400 bg-indigo-50 text-indigo-800'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                      <span className="flex items-center gap-2">
                        🎁
                        <span>Promosi</span>
                        {appliedPromotion && (
                          <span className="text-xs font-black text-indigo-600">✓ {appliedPromotion.name}</span>
                        )}
                      </span>
                      {variantPromoOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>

                    {variantPromoOpen && (
                      <div className="mt-2 space-y-1.5">
                        {activePromos.map(promo => {
                          const isApplied = appliedPromotion?.id === promo.id
                          const disc = calcPromotionDiscount(promo, cart, subtotal)
                          return (
                            <button
                              key={promo.id}
                              onClick={() => setAppliedPromotion(isApplied ? null : promo)}
                              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border-2 text-left transition-all ${
                                isApplied
                                  ? 'border-green-400 bg-green-50'
                                  : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
                              <div className="min-w-0">
                                <p className={`text-xs font-black truncate ${isApplied ? 'text-green-800' : 'text-gray-800'}`}>{promo.name}</p>
                                <p className="text-[10px] text-gray-400">
                                  {promo.type === 'percentage' ? `${promo.value}% diskon`
                                    : promo.type === 'fixed' ? `Hemat ${BRAND.currency.format(promo.value)}`
                                    : 'Buy 1 Get 1'}
                                </p>
                              </div>
                              <span className={`text-xs font-black flex-shrink-0 ml-2 ${isApplied ? 'text-green-600' : 'text-indigo-600'}`}>
                                {isApplied ? '✓ Aktif' : disc > 0 ? `-${BRAND.currency.format(disc)}` : ''}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>

            {/* ── Confirm button ── */}
            <div className="px-5 pb-5 pt-3 border-t border-gray-100 flex-shrink-0">
              <button
                onClick={handleConfirmVariants}
                disabled={totalVariantsSelected === 0}
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all flex items-center justify-center gap-2 text-base">
                {totalVariantsSelected === 0
                  ? 'Pilih minimal 1 varian'
                  : `+ Tambah ${totalVariantsSelected} item ke Keranjang`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* CHECKOUT MODAL                                    */}
      {/* ══════════════════════════════════════════════════ */}
      {isCheckoutOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">Pembayaran</h2>
              <button onClick={() => setIsCheckoutOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">

              {/* Summary */}
              <div className="bg-gray-50 rounded-2xl p-4 space-y-2">
                <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Ringkasan</p>
                {cart.map(item => (
                  <div key={`${item.productId}-${item.variantSize}`} className="flex justify-between text-sm">
                    <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                    <span className="font-bold text-gray-900">{BRAND.currency.format(item.subtotal)}</span>
                  </div>
                ))}
                <div className="border-t border-gray-200 pt-2 space-y-1">
                  <div className="flex justify-between text-sm text-gray-500">
                    <span>Subtotal</span><span>{BRAND.currency.format(subtotal)}</span>
                  </div>
                  {discountAmount > 0 && (
                    <div className="flex justify-between text-sm text-green-600 font-bold">
                      <span>Diskon{appliedPromotion ? ` (${appliedPromotion.name})` : appliedPromoCode ? ` (${appliedPromoCode.code})` : ''}</span>
                      <span>-{BRAND.currency.format(discountAmount)}</span>
                    </div>
                  )}
                  {surchargeAmount > 0 && (
                    <div className="flex justify-between text-sm text-orange-600 font-bold">
                      <span>Surcharge</span>
                      <span>+{BRAND.currency.format(surchargeAmount)}</span>
                    </div>
                  )}
                  {settings.taxEnabled && (
                    <div className="flex justify-between text-sm text-gray-500">
                      <span>PPN {settings.taxRate}%</span><span>{BRAND.currency.format(taxAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-black text-gray-900 text-base pt-1">
                    <span>Total</span>
                    <span className="text-indigo-600">{BRAND.currency.format(total)}</span>
                  </div>
                </div>
                {selectedCustomer && (
                  <div className="pt-1 border-t border-gray-200 flex justify-between text-xs">
                    <span className="text-gray-500">Pelanggan</span>
                    <span className="font-bold text-indigo-600">{selectedCustomer.name}</span>
                  </div>
                )}
                {orderNotes && (
                  <div className="pt-1 border-t border-gray-200">
                    <p className="text-xs text-gray-500">📝 {orderNotes}</p>
                  </div>
                )}
              </div>

              {/* Salesman */}
              <div>
                <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">
                  Salesman / SPG yang Melayani
                </p>
                <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                  {allUsers.map(u => (
                    <button
                      key={u.id}
                      onClick={() => setSelectedSalesman(selectedSalesman?.uid === u.uid ? null : u)}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border-2 text-left transition-all ${
                        selectedSalesman?.uid === u.uid
                          ? 'border-indigo-600 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {u.photoURL
                          ? <img src={u.photoURL} alt="" className="w-full h-full object-cover" />
                          : <span className="text-xs font-black text-indigo-600">{u.displayName.charAt(0)}</span>}
                      </div>
                      <div className="min-w-0">
                        <p className={`text-xs font-bold truncate ${selectedSalesman?.uid === u.uid ? 'text-indigo-700' : 'text-gray-900'}`}>
                          {u.displayName}
                        </p>
                        <p className="text-xs text-gray-400 capitalize">{u.role}</p>
                      </div>
                    </button>
                  ))}
                </div>
                {!selectedSalesman && (
                  <p className="text-xs text-orange-500 mt-1">Pilih salesman yang melayani</p>
                )}
              </div>

              {/* Payment Method */}
              <div>
                <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Metode Pembayaran</p>
                <div className="grid grid-cols-2 gap-2">
                  {enabledPaymentMethods.map(pm => (
                    <button
                      key={pm.id}
                      onClick={() => { setPaymentMethod(pm.id as PaymentMethod); setAmountPaid('') }}
                      className={`flex items-center gap-2 p-3 rounded-2xl border-2 font-bold text-sm transition-all ${
                        paymentMethod === pm.id
                          ? 'border-indigo-600 bg-indigo-50 text-indigo-600'
                          : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                      {paymentIcons[pm.id] || <Tag className="w-4 h-4" />} {pm.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cash input */}
              {paymentMethod === PaymentMethod.CASH && (
                <div>
                  <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Jumlah Bayar</p>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[total, Math.ceil(total / 50000) * 50000, Math.ceil(total / 100000) * 100000]
                      .filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
                      .map(amount => (
                        <button
                          key={amount}
                          onClick={() => setAmountPaid(amount.toString())}
                          className="py-3 px-2 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 text-gray-600 text-xs font-bold rounded-xl transition-all active:bg-indigo-100">
                          {BRAND.currency.format(amount)}
                        </button>
                      ))}
                  </div>
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="Masukkan jumlah..."
                    value={amountPaid}
                    onChange={e => setAmountPaid(e.target.value)}
                    className="w-full p-4 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-xl focus:outline-none"
                  />
                  {paid >= total && (
                    <div className="mt-2 p-3 bg-green-50 rounded-xl flex justify-between">
                      <span className="text-sm font-bold text-green-700">Kembalian</span>
                      <span className="text-lg font-black text-green-700">{BRAND.currency.format(change)}</span>
                    </div>
                  )}
                  {paid > 0 && paid < total && (
                    <div className="mt-2 p-3 bg-red-50 rounded-xl flex justify-between">
                      <span className="text-sm font-bold text-red-500">Kurang</span>
                      <span className="text-lg font-black text-red-500">{BRAND.currency.format(total - paid)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Points preview */}
              {selectedCustomer && loyalty.enabled && earnedPoints > 0 && (
                <div className="bg-indigo-50 rounded-xl p-3 flex justify-between">
                  <span className="text-xs font-bold text-indigo-700">Poin diperoleh</span>
                  <span className="text-sm font-black text-indigo-700">+{earnedPoints}</span>
                </div>
              )}
            </div>

            <div className="px-6 pb-6">
              <button
                onClick={handleConfirmPayment}
                disabled={isProcessing || (paymentMethod === PaymentMethod.CASH && paid < total)}
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all flex items-center justify-center gap-2">
                {isProcessing
                  ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />Memproses...</>
                  : 'Konfirmasi Pembayaran'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* SUCCESS MODAL                                     */}
      {/* ══════════════════════════════════════════════════ */}
      {isSuccessOpen && lastOrder && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm text-center p-8">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-10 h-10 text-green-500" />
            </div>
            <h2 className="text-2xl font-black text-gray-900 mb-1">Berhasil!</h2>
            <p className="text-gray-400 text-sm mb-4">{lastOrder.orderNumber}</p>
            <div className="bg-gray-50 rounded-2xl p-4 text-left space-y-2 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Total</span>
                <span className="font-black text-gray-900">{BRAND.currency.format(lastOrder.total)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Metode</span>
                <span className="font-bold text-gray-900 capitalize">{lastOrder.paymentMethod}</span>
              </div>
              {lastOrder.paymentMethod === PaymentMethod.CASH && lastOrder.change > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Kembalian</span>
                  <span className="font-black text-green-600">{BRAND.currency.format(lastOrder.change)}</span>
                </div>
              )}
              {lastOrder.customerName && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Pelanggan</span>
                  <span className="font-bold text-indigo-600">{lastOrder.customerName}</span>
                </div>
              )}
              {lastOrder.salesmanName && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Salesman</span>
                  <span className="font-bold text-gray-900">{lastOrder.salesmanName}</span>
                </div>
              )}
              {lastOrder.notes && (
                <div className="text-xs text-gray-500 bg-yellow-50 rounded-lg px-2 py-1">📝 {lastOrder.notes}</div>
              )}
            </div>
            <button
              onClick={() => setIsSuccessOpen(false)}
              className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-2xl transition-all">
              Transaksi Baru
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* HISTORY MODAL                                     */}
      {/* ══════════════════════════════════════════════════ */}
      {isHistoryOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">Riwayat Transaksi</h2>
                <p className="text-xs text-gray-400">
                  {historyOrders.filter(o => {
                    const q = historySearch.toLowerCase()
                    return !q || (o.customerName||'').toLowerCase().includes(q) ||
                      o.orderNumber.toLowerCase().includes(q) ||
                      (customers.find(c => c.id === o.customerId)?.phone || '').includes(q)
                  }).length} transaksi ·{' '}
                  Total:{' '}
                  {BRAND.currency.format(
                    historyOrders
                      .filter(o => {
                        const q = historySearch.toLowerCase()
                        return !q || (o.customerName||'').toLowerCase().includes(q) ||
                          o.orderNumber.toLowerCase().includes(q) ||
                          (customers.find(c => c.id === o.customerId)?.phone || '').includes(q)
                      })
                      .filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0)
                  )}
                </p>
              </div>
              <button onClick={() => setIsHistoryOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Date range filter */}
            <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-shrink-0 flex-wrap">
              <Calendar className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap gap-y-2">
                <input
                  type="date"
                  value={historyDateFrom}
                  max={historyDateTo}
                  onChange={e => handleHistoryDateChange('from', e.target.value)}
                  className="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <span className="text-gray-400 text-sm font-bold">→</span>
                <input
                  type="date"
                  value={historyDateTo}
                  min={historyDateFrom}
                  onChange={e => handleHistoryDateChange('to', e.target.value)}
                  className="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <span className="text-xs text-gray-400">Maks. 31 hari</span>
              </div>
            </div>

            {/* Search bar */}
            <div className="px-6 py-2 border-b border-gray-100 flex-shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cari no. struk, nama, atau no. telepon pelanggan..."
                  value={historySearch}
                  onChange={e => setHistorySearch(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {historySearch && (
                  <button
                    onClick={() => setHistorySearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Order list */}
            <div className="flex-1 overflow-y-auto">
              {isLoadingHistory ? (
                <div className="p-8 text-center text-gray-300">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
                  <p>Memuat riwayat...</p>
                </div>
              ) : historyOrders.length === 0 ? (
                <div className="p-12 text-center text-gray-300">
                  <History className="w-12 h-12 mx-auto mb-3" />
                  <p className="font-bold">Tidak ada transaksi pada rentang ini</p>
                </div>
              ) : (() => {
                const searchQ = historySearch.toLowerCase()
                const visibleOrders = historySearch
                  ? historyOrders.filter(o =>
                      (o.customerName || '').toLowerCase().includes(searchQ) ||
                      o.orderNumber.toLowerCase().includes(searchQ) ||
                      (customers.find(c => c.id === o.customerId)?.phone || '').includes(searchQ))
                  : historyOrders
                if (visibleOrders.length === 0) return (
                  <div className="p-12 text-center text-gray-300">
                    <Search className="w-12 h-12 mx-auto mb-3" />
                    <p className="font-bold">Tidak ada hasil untuk "{historySearch}"</p>
                  </div>
                )
                return (
                <div className="divide-y divide-gray-50">
                  {visibleOrders.map(order => (
                    <div key={order.id}>

                      {/* Order row */}
                      <div
                        className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-all"
                        onClick={() => {
                          setHistoryExpanded(historyExpanded === order.id ? null : order.id!)
                          setHistoryRefundId(null)
                          setHistoryRefundNote('')
                        }}>
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${
                          order.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                          <ShoppingCart className={`w-4 h-4 ${
                            order.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                          <p className="text-xs text-gray-400 truncate">
                            {format(parseISO(order.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })}
                            {' · '}{order.cashierName}
                            {order.salesmanName && ` · ${order.salesmanName}`}
                            {order.customerName && ` · ${order.customerName}`}
                            {' · '}<span className="capitalize">{order.paymentMethod}</span>
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`px-2 py-0.5 text-xs font-bold rounded-lg ${
                            order.status === 'refunded'
                              ? 'bg-red-50 text-red-600'
                              : 'bg-green-50 text-green-700'}`}>
                            {order.status === 'refunded' ? 'Refund' : 'Selesai'}
                          </span>
                          <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                          {historyExpanded === order.id
                            ? <ChevronUp className="w-4 h-4 text-gray-400" />
                            : <ChevronDown className="w-4 h-4 text-gray-400" />}
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {historyExpanded === order.id && (
                        <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
                          <div className="pt-3 space-y-1.5">
                            {order.items.map((item, i) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                                <span className="font-bold">{BRAND.currency.format(item.subtotal)}</span>
                              </div>
                            ))}
                            <div className="border-t border-gray-200 pt-2 space-y-0.5">
                              {order.discountAmount > 0 && (
                                <div className="flex justify-between text-xs text-green-600 font-bold">
                                  <span>Diskon{order.discountCode ? ` (${order.discountCode})` : ''}</span>
                                  <span>-{BRAND.currency.format(order.discountAmount)}</span>
                                </div>
                              )}
                              <div className="flex justify-between font-black text-gray-900">
                                <span>Total</span>
                                <span>{BRAND.currency.format(order.total)}</span>
                              </div>
                              {order.paymentMethod === 'cash' && order.change > 0 && (
                                <div className="flex justify-between text-xs text-green-600 font-bold">
                                  <span>Kembalian</span>
                                  <span>{BRAND.currency.format(order.change)}</span>
                                </div>
                              )}
                            </div>

                            {order.notes && (
                              <p className="text-xs text-gray-500 bg-yellow-50 rounded-lg px-2 py-1.5">📝 {order.notes}</p>
                            )}

                            {order.status === 'refunded' && order.refundReason && (
                              <div className="bg-red-50 rounded-xl p-3">
                                <p className="text-xs font-black text-red-600 mb-1">Alasan Refund</p>
                                <p className="text-xs text-red-700">{order.refundReason}</p>
                                {order.refundedAt && (
                                  <p className="text-xs text-red-400 mt-1">
                                    {format(parseISO(order.refundedAt), 'dd MMM yyyy HH:mm', { locale: idLocale })}
                                  </p>
                                )}
                              </div>
                            )}

                            {/* Refund section — completed orders only */}
                            {order.status === OrderStatus.COMPLETED && (
                              <div className="pt-1">
                                {historyRefundId === order.id ? (
                                  <div className="space-y-2">
                                    <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Alasan Refund *</p>
                                    <textarea
                                      value={historyRefundNote}
                                      onChange={e => setHistoryRefundNote(e.target.value)}
                                      placeholder="Tuliskan alasan refund secara jelas..."
                                      rows={2}
                                      className="w-full px-3 py-2 bg-white border-2 border-red-200 rounded-xl text-sm resize-none focus:outline-none focus:border-red-400"
                                    />
                                    <div className="flex gap-2">
                                      <button
                                        onClick={() => { setHistoryRefundId(null); setHistoryRefundNote('') }}
                                        className="flex-1 py-2 border border-gray-200 text-gray-600 text-xs font-bold rounded-xl hover:bg-gray-100">
                                        Batal
                                      </button>
                                      <button
                                        onClick={handleHistoryRefund}
                                        disabled={isRefundingHistory}
                                        className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1">
                                        {isRefundingHistory
                                          ? <><Loader2 className="w-3 h-3 animate-spin" />Proses...</>
                                          : 'Konfirmasi Refund'}
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <button
                                    onClick={e => {
                                      e.stopPropagation()
                                      setHistoryRefundId(order.id!)
                                      setHistoryRefundNote('')
                                    }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-red-500 hover:bg-red-50 text-xs font-bold rounded-xl transition-all">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Proses Refund
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                )
              })()}
            </div>

            {/* Footer summary */}
            {historyOrders.length > 0 && (
              <div className="border-t border-gray-100 px-6 py-4 flex justify-between items-center flex-shrink-0 flex-wrap gap-2">
                <div className="flex gap-4 text-xs">
                  <span className="text-gray-500">
                    <span className="font-bold text-green-600">
                      {historyOrders.filter(o => o.status === 'completed').length}
                    </span> selesai
                  </span>
                  <span className="text-gray-500">
                    <span className="font-bold text-red-500">
                      {historyOrders.filter(o => o.status === 'refunded').length}
                    </span> refund
                  </span>
                </div>
                <p className="text-lg font-black text-indigo-600">
                  {BRAND.currency.format(
                    historyOrders
                      .filter(o => o.status === 'completed')
                      .reduce((s, o) => s + o.total, 0)
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* NOTES MODAL                                       */}
      {/* ══════════════════════════════════════════════════ */}
      {activeAdjustment === 'notes' && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
          onClick={() => setActiveAdjustment(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-black text-gray-900">📝 Catatan Transaksi</h3>
              <button onClick={() => setActiveAdjustment(null)} className="p-1.5 hover:bg-gray-100 rounded-xl">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="p-5">
              <textarea
                value={orderNotes}
                onChange={e => setOrderNotes(e.target.value)}
                placeholder="Tulis catatan untuk transaksi ini..."
                rows={4}
                autoFocus
                className="w-full px-4 py-3 bg-yellow-50 border-2 border-yellow-200 rounded-2xl text-sm resize-none focus:outline-none focus:border-yellow-400"
              />
            </div>
            <div className="px-5 pb-5 flex gap-3">
              {orderNotes && (
                <button onClick={() => setOrderNotes('')}
                  className="px-4 py-2.5 text-sm font-bold text-red-500 hover:bg-red-50 rounded-xl transition-all">
                  Hapus
                </button>
              )}
              <button onClick={() => setActiveAdjustment(null)}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl text-sm transition-all">
                Simpan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* DISKON / SURCHARGE MODAL                          */}
      {/* ══════════════════════════════════════════════════ */}
      {activeAdjustment === 'discount' && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
          onClick={() => setActiveAdjustment(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="font-black text-gray-900">🏷️ Diskon / Surcharge</h3>
              <button onClick={() => setActiveAdjustment(null)} className="p-1.5 hover:bg-gray-100 rounded-xl">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Type toggle */}
              <div className="flex gap-2">
                {(['fixed', 'percentage'] as const).map(t => (
                  <button key={t}
                    onClick={() => { setDiscountType(t); setDiscountRunning(0); setSurchargeRunning(0); setAdjustInputStr('') }}
                    className={`flex-1 py-2 text-sm font-bold rounded-xl border-2 transition-all ${
                      discountType === t ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-500'}`}>
                    {t === 'fixed' ? 'Rp Nominal' : '% Persen'}
                  </button>
                ))}
              </div>

              {/* Input row */}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={adjustInputStr}
                  onChange={e => setAdjustInputStr(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyDiscount() }}
                  placeholder={discountType === 'fixed' ? '50000' : '10'}
                  autoFocus
                  className="flex-1 px-0.5 py-2 bg-gray-50 border-2 border-gray-200 rounded-2xl text-lg font-black focus:outline-none focus:border-indigo-500 text-center"
                />
                {/* − discount (reduce total) */}
                <button onClick={applyDiscount}
                  className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-green-100 hover:bg-green-200 text-green-700 rounded-2xl font-black text-xl transition-all border-2 border-green-300">
                  <Minus className="w-5 h-5" />
                </button>
                {/* + surcharge (add to total) */}
                <button onClick={applySurcharge}
                  className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-2xl font-black text-xl transition-all border-2 border-orange-300">
                  <Plus className="w-5 h-5" />
                </button>
              </div>

              <div className="flex gap-2 text-xs text-gray-400 justify-center">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-200 inline-block"/>  − kurangi total</span>
                <span className="flex items-center gap-1 ml-3"><span className="w-3 h-3 rounded bg-orange-200 inline-block"/>  + tambah total</span>
              </div>

              {/* Active rows */}
              {discountRunning > 0 && (
                <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-4 py-2.5">
                  <span className="text-sm font-bold text-green-700">
                    Diskon: {discountType === 'percentage'
                      ? `-${discountRunning}% (${BRAND.currency.format(manualDiscountAmount)})`
                      : `-${BRAND.currency.format(discountRunning)}`}
                  </span>
                  <button onClick={() => setDiscountRunning(0)} className="text-red-400 hover:text-red-600 font-black ml-3 text-lg">×</button>
                </div>
              )}
              {surchargeRunning > 0 && (
                <div className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-xl px-4 py-2.5">
                  <span className="text-sm font-bold text-orange-700">
                    Surcharge: {discountType === 'percentage'
                      ? `+${surchargeRunning}% (+${BRAND.currency.format(surchargeAmount)})`
                      : `+${BRAND.currency.format(surchargeRunning)}`}
                  </span>
                  <button onClick={() => setSurchargeRunning(0)} className="text-red-400 hover:text-red-600 font-black ml-3 text-lg">×</button>
                </div>
              )}
            </div>
            <div className="px-5 pb-5">
              <button onClick={() => setActiveAdjustment(null)}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl text-sm transition-all">
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* PROMOSI MODAL                                     */}
      {/* ══════════════════════════════════════════════════ */}
      {activeAdjustment === 'promo' && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4"
          onClick={() => setActiveAdjustment(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm max-h-[75vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
              <h3 className="font-black text-gray-900">🎁 Pilih Promosi</h3>
              <button onClick={() => setActiveAdjustment(null)} className="p-1.5 hover:bg-gray-100 rounded-xl">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {(() => {
                const now = new Date().toISOString().slice(0, 10)
                const activePromos = promotions.filter(p => {
                  if (!p.isActive) return false
                  if (p.startDate && p.startDate > now) return false
                  if (p.endDate   && p.endDate   < now) return false
                  return true
                })
                if (activePromos.length === 0) return (
                  <div className="text-center py-8 text-gray-400">
                    <p className="text-3xl mb-2">🎁</p>
                    <p className="font-bold text-sm">Tidak ada promosi aktif</p>
                    <p className="text-xs mt-1">Tambahkan promosi di Back Office</p>
                  </div>
                )
                return activePromos.map(promo => {
                  const isApplied = appliedPromotion?.id === promo.id
                  const discount  = calcPromotionDiscount(promo, cart, subtotal)
                  const hasMatchingProducts = !promo.applicableProductIds?.length ||
                    cart.some(i => promo.applicableProductIds!.includes(i.productId))
                  return (
                    <button key={promo.id}
                      disabled={!hasMatchingProducts}
                      onClick={() => { setAppliedPromotion(isApplied ? null : promo); setActiveAdjustment(null) }}
                      className={`w-full flex items-center justify-between p-4 rounded-2xl border-2 text-left transition-all ${
                        isApplied
                          ? 'border-green-400 bg-green-50'
                          : !hasMatchingProducts
                            ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                            : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-black ${isApplied ? 'text-green-800' : 'text-gray-900'}`}>{promo.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {promo.type === 'percentage' ? `${promo.value}% diskon`
                            : promo.type === 'fixed' ? `Hemat ${BRAND.currency.format(promo.value)}`
                            : 'Buy 1 Get 1'}
                          {promo.applicableProductIds?.length ? ` · ${promo.applicableProductIds.length} produk` : ' · Semua produk'}
                          {!hasMatchingProducts && ' · Produk tidak ada di keranjang'}
                        </p>
                        {promo.endDate && (
                          <p className="text-[10px] text-gray-300 mt-0.5">Berlaku s/d {promo.endDate}</p>
                        )}
                      </div>
                      <div className="flex-shrink-0 ml-3 text-right">
                        {isApplied
                          ? <span className="text-sm font-black text-green-600">✓ Aktif</span>
                          : discount > 0
                            ? <span className="text-sm font-black text-indigo-600">-{BRAND.currency.format(discount)}</span>
                            : null}
                      </div>
                    </button>
                  )
                })
              })()}
            </div>
            {appliedPromotion && (
              <div className="px-5 pb-5 pt-2 border-t border-gray-100 flex-shrink-0">
                <button onClick={() => { setAppliedPromotion(null); setActiveAdjustment(null) }}
                  className="w-full py-2.5 text-sm font-bold text-red-500 hover:bg-red-50 rounded-xl transition-all">
                  Hapus Promosi Aktif
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* SHIFT RECAP MODAL                                 */}
      {/* ══════════════════════════════════════════════════ */}
      {isShiftRecapOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">📋 Rekap Shift</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
              <button onClick={() => setIsShiftRecapOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {isLoadingShift ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              </div>
            ) : (() => {
              const completed   = shiftOrders.filter(o => o.status === 'completed')
              const refunded    = shiftOrders.filter(o => o.status === 'refunded')
              const totalRev    = completed.reduce((s, o) => s + o.total, 0)
              const totalRefund = refunded.reduce((s, o) => s + o.total, 0)
              const byMethod    = completed.reduce((acc, o) => {
                acc[o.paymentMethod] = (acc[o.paymentMethod] || 0) + o.total
                return acc
              }, {} as Record<string, number>)
              const methodLabels: Record<string, string> = { cash: 'Tunai', card: 'Kartu', qris: 'QRIS', transfer: 'Transfer' }
              return (
                <div className="flex-1 overflow-y-auto p-5 space-y-4">

                  {/* Summary cards */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-indigo-50 rounded-2xl p-4">
                      <p className="text-xs font-bold text-indigo-500 mb-1">Total Penjualan</p>
                      <p className="text-xl font-black text-indigo-700">{BRAND.currency.format(totalRev)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-2xl p-4">
                      <p className="text-xs font-bold text-gray-400 mb-1">Transaksi</p>
                      <p className="text-xl font-black text-gray-700">{completed.length}</p>
                    </div>
                    {totalRefund > 0 && (
                      <div className="bg-red-50 rounded-2xl p-4">
                        <p className="text-xs font-bold text-red-400 mb-1">Total Refund</p>
                        <p className="text-xl font-black text-red-600">{BRAND.currency.format(totalRefund)}</p>
                      </div>
                    )}
                    {refunded.length > 0 && (
                      <div className="bg-orange-50 rounded-2xl p-4">
                        <p className="text-xs font-bold text-orange-400 mb-1">Direfund</p>
                        <p className="text-xl font-black text-orange-600">{refunded.length} transaksi</p>
                      </div>
                    )}
                  </div>

                  {/* By payment method */}
                  {Object.keys(byMethod).length > 0 && (
                    <div className="bg-white border-2 border-gray-100 rounded-2xl p-4 space-y-2.5">
                      <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Per Metode Pembayaran</p>
                      {Object.entries(byMethod).sort(([,a],[,b]) => b - a).map(([method, amount]) => (
                        <div key={method} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-indigo-400" />
                            <span className="text-sm font-bold text-gray-700">{methodLabels[method] || method}</span>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-black text-gray-900">{BRAND.currency.format(amount)}</p>
                            <p className="text-[10px] text-gray-400">
                              {totalRev > 0 ? Math.round((amount / totalRev) * 100) : 0}%
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Recent transactions */}
                  {shiftOrders.length > 0 && (
                    <div>
                      <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Transaksi Hari Ini</p>
                      <div className="space-y-1.5">
                        {shiftOrders.slice(0, 10).map(order => (
                          <div key={order.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-xl">
                            <div>
                              <p className="text-xs font-bold text-gray-900">{order.orderNumber}</p>
                              <p className="text-[10px] text-gray-400">
                                {new Date(order.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                                {' · '}{order.cashierName}
                              </p>
                            </div>
                            <div className="text-right">
                              <span className={`text-xs font-black ${order.status === 'refunded' ? 'text-red-500' : 'text-indigo-600'}`}>
                                {order.status === 'refunded' ? 'Refund' : BRAND.currency.format(order.total)}
                              </span>
                            </div>
                          </div>
                        ))}
                        {shiftOrders.length > 10 && (
                          <p className="text-xs text-gray-400 text-center pt-1">+{shiftOrders.length - 10} transaksi lainnya</p>
                        )}
                      </div>
                    </div>
                  )}

                  {shiftOrders.length === 0 && (
                    <div className="text-center py-8 text-gray-400">
                      <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p className="font-bold text-sm">Belum ada transaksi hari ini</p>
                    </div>
                  )}
                </div>
              )
            })()}

            <div className="px-5 pb-5 pt-2 border-t border-gray-100 flex-shrink-0">
              <button onClick={() => setIsShiftRecapOpen(false)}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl text-sm transition-all">
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* SETTINGS MODAL                                    */}
      {/* ══════════════════════════════════════════════════ */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">⚙️ Pengaturan Kasir</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {/* Quick info */}
              <div className="bg-gray-50 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 font-medium">Kasir</span>
                  <span className="font-bold text-gray-900">{appUser.displayName}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 font-medium">Role</span>
                  <span className="font-bold text-gray-900 capitalize">{appUser.role}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 font-medium">Pajak</span>
                  <span className="font-bold text-gray-900">
                    {settings.taxEnabled ? `PPN ${settings.taxRate}%` : 'Nonaktif'}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500 font-medium">Pembulatan</span>
                  <span className="font-bold text-gray-900">
                    {settings.roundingEnabled
                      ? settings.roundingType === 'nearest_1000' ? 'Rp 1.000' : 'Rp 500'
                      : 'Nonaktif'}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest px-1">Aksi Cepat</p>

              <button
                onClick={() => { setIsSettingsOpen(false); setIsHistoryOpen(true); setHistorySearch('') }}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-white border-2 border-gray-100 hover:border-indigo-300 hover:bg-indigo-50 rounded-2xl transition-all text-left">
                <History className="w-5 h-5 text-indigo-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-gray-900">Riwayat Transaksi</p>
                  <p className="text-xs text-gray-400">Lihat & cari transaksi, proses refund</p>
                </div>
              </button>

              <button
                onClick={() => { setIsSettingsOpen(false); openShiftRecap() }}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-white border-2 border-gray-100 hover:border-indigo-300 hover:bg-indigo-50 rounded-2xl transition-all text-left">
                <ClipboardList className="w-5 h-5 text-indigo-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-gray-900">Rekap Shift Hari Ini</p>
                  <p className="text-xs text-gray-400">Ringkasan transaksi & pendapatan hari ini</p>
                </div>
              </button>

              <button
                onClick={() => window.location.href = '/backoffice'}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-white border-2 border-gray-100 hover:border-indigo-300 hover:bg-indigo-50 rounded-2xl transition-all text-left">
                <Settings className="w-5 h-5 text-indigo-500 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-gray-900">Back Office</p>
                  <p className="text-xs text-gray-400">Produk, laporan, pengaturan sistem</p>
                </div>
              </button>

              <button
                onClick={() => { setIsSettingsOpen(false); onLogout() }}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-white border-2 border-red-100 hover:border-red-300 hover:bg-red-50 rounded-2xl transition-all text-left">
                <LogOut className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-red-600">Keluar</p>
                  <p className="text-xs text-gray-400">Logout dari sesi ini</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      </div>{/* end flex-1 flex-col min-w-0 (right panel) */}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SIMPLIFIED PRODUCT CARD — image + name only, tap to open
// ─────────────────────────────────────────────────────────────
function ProductCard({
  product,
  onSelect,
  onToggleFavourite,
}: {
  product: Product
  onSelect: (p: Product) => void
  onToggleFavourite: (p: Product) => void
}) {
  const totalStock = product.variants.reduce((s, v) => s + v.stock, 0)
  const isOutOfStock = totalStock === 0
  const isLowStock = totalStock > 0 && totalStock <= 5

  return (
    <div
      onClick={() => !isOutOfStock && onSelect(product)}
      className={`bg-white rounded-2xl overflow-hidden shadow-sm transition-all border border-gray-100 flex flex-col ${
        isOutOfStock
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:shadow-md hover:-translate-y-0.5 cursor-pointer active:scale-[0.97]'
      }`}>

      {/* Image */}
      <div className="relative w-full aspect-square bg-gray-100 overflow-hidden">
        {product.imageUrl
          ? <img
              src={product.imageUrl}
              alt={product.name}
              className="w-full h-full object-cover"
            />
          : <div className="w-full h-full flex items-center justify-center">
              <Package className="w-8 h-8 text-gray-300" />
            </div>}

        {/* Out of stock overlay */}
        {isOutOfStock && (
          <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
            <span className="text-xs font-black text-gray-500 bg-white rounded-lg px-2 py-1 shadow-sm">Habis</span>
          </div>
        )}

        {/* Low stock badge */}
        {isLowStock && !isOutOfStock && (
          <div className="absolute top-1.5 left-1.5">
            <span className="text-[10px] font-black text-red-600 bg-red-50 rounded-lg px-1.5 py-0.5">
              Stok {totalStock}
            </span>
          </div>
        )}

        {/* Favourite button */}
        <button
          onClick={e => { e.stopPropagation(); onToggleFavourite(product) }}
          className="absolute top-1.5 right-1.5 w-7 h-7 bg-white/90 rounded-full flex items-center justify-center shadow-sm hover:bg-white transition-all">
          <Heart className={`w-3.5 h-3.5 ${product.isFavourite ? 'fill-red-500 text-red-500' : 'text-gray-400'}`} />
        </button>
      </div>

      {/* Name + brand */}
      <div className="p-2.5 flex-1">
        <p className="font-bold text-gray-900 text-xs leading-tight line-clamp-2">{product.name}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">{product.brand}</p>
        <p className="text-[10px] text-gray-300 mt-0.5">{product.variants.length} varian</p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CART ITEM ROW — unchanged
// ─────────────────────────────────────────────────────────────
function CartItemRow({
  item, index, cart, setCart,
}: {
  item: CartItem
  index: number
  cart: CartItem[]
  setCart: (c: CartItem[]) => void
}) {
  const updateQty = (delta: number) => {
    const updated = [...cart]
    updated[index] = { ...updated[index] }
    updated[index].quantity += delta
    if (updated[index].quantity <= 0) {
      updated.splice(index, 1)
    } else {
      updated[index].subtotal = Math.round(updated[index].quantity * updated[index].price)
    }
    setCart(updated)
  }

  return (
    <div className="bg-gray-50 rounded-xl p-3 active:bg-gray-100 transition-colors select-none">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{item.productName}</p>
          <p className="text-xs text-gray-400">{item.variantSize} · {BRAND.currency.format(item.price)}</p>
        </div>
        <button
          onClick={() => updateQty(-item.quantity)}
          className="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-red-500 active:text-red-600 transition-colors flex-shrink-0 rounded-lg hover:bg-red-50">
          ✕
        </button>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => updateQty(-1)}
            className="w-9 h-9 rounded-xl bg-white border-2 border-gray-200 text-gray-700 text-base font-bold hover:bg-gray-100 active:bg-gray-200 flex items-center justify-center transition-all">
            −
          </button>
          <span className="w-7 text-center text-sm font-black text-gray-900">{item.quantity}</span>
          <button
            onClick={() => updateQty(1)}
            className="w-9 h-9 rounded-xl bg-white border-2 border-gray-200 text-gray-700 text-base font-bold hover:bg-gray-100 active:bg-gray-200 flex items-center justify-center transition-all">
            +
          </button>
        </div>
        <p className="text-sm font-black text-gray-900">{BRAND.currency.format(item.subtotal)}</p>
      </div>
    </div>
  )
}