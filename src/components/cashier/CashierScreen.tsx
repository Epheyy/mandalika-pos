import { useState, useEffect, useRef } from 'react'
import type { AppUser, Product, Category, CartItem, Order, Customer, LoyaltySettings, AppSettings } from '../../types'
import { PaymentMethod, OrderStatus } from '../../types'
import { db } from '../../firebase'
import {
  collection, onSnapshot, addDoc, doc, getDoc,
  updateDoc, query, orderBy, where, getDocs
} from 'firebase/firestore'
import { BRAND } from '../../config/brand'
import {
  Search, ShoppingCart, LogOut, Package, Database, X, CheckCircle,
  Banknote, CreditCard, Smartphone, ArrowLeftRight, History,
  ChevronDown, ChevronUp, User, Tag, FileText, Heart,
  UserPlus, Plus, Minus, Loader2, RotateCcw, Gift, Calendar
} from 'lucide-react'
import { seedDatabase } from '../../lib/seedData'
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

  // ── Adjustments panel (notes / discount / promo) ──────────
  const [activeAdjustment, setActiveAdjustment] = useState<'notes' | 'discount' | 'promo' | null>(null)
  const [orderNotes,        setOrderNotes]        = useState('')
  const [discountType,      setDiscountType]      = useState<'percentage' | 'fixed'>('fixed')
  const [discountRunning,   setDiscountRunning]   = useState(0)   // accumulated value
  const [discountInputStr,  setDiscountInputStr]  = useState('')  // what user is typing
  const [promoCode,         setPromoCode]         = useState('')
  const [appliedPromoCode,  setAppliedPromoCode]  = useState<{
    code: string; value: number; type: 'percentage' | 'fixed'
  } | null>(null)
  const [isApplyingPromo, setIsApplyingPromo] = useState(false)

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

  // ── Firestore subscriptions ───────────────────────────────
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'products'), s => {
      setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive))
      setIsLoadingProducts(false)
    })
    const u2 = onSnapshot(collection(db, 'categories'), s =>
      setCategories(s.docs.map(d => ({ id: d.id, ...d.data() } as Category))))
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
    return () => { u1(); u2(); u3(); u4(); u5(); u6() }
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

  const promoDiscountAmount = appliedPromoCode
    ? appliedPromoCode.type === 'percentage'
      ? Math.round(subtotal * (appliedPromoCode.value / 100))
      : Math.min(appliedPromoCode.value, subtotal)
    : 0

  const discountAmount  = Math.min(manualDiscountAmount + promoDiscountAmount, subtotal)
  const taxableAmount   = subtotal - discountAmount
  const taxAmount       = settings.taxEnabled ? Math.round(taxableAmount * (settings.taxRate / 100)) : 0
  let total             = taxableAmount + taxAmount
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
      const existingIndex = newCart.findIndex(
        i => i.productId === selectedProductForCart.id && i.variantSize === variant.size
      )
      if (existingIndex >= 0) {
        newCart[existingIndex].quantity += qty
        newCart[existingIndex].subtotal = newCart[existingIndex].quantity * newCart[existingIndex].price
      } else {
        newCart.push({
          productId:   selectedProductForCart.id!,
          productName: selectedProductForCart.name,
          variantSize: variant.size,
          price:       variant.price,
          quantity:    qty,
          subtotal:    variant.price * qty,
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

  // ── Discount helpers ──────────────────────────────────────
  const applyDiscountAdjustment = (sign: 1 | -1) => {
    const val = parseFloat(discountInputStr) || 0
    if (val <= 0) return
    setDiscountRunning(prev => Math.max(0, prev + sign * val))
    setDiscountInputStr('')
  }

  // ── Promo code ────────────────────────────────────────────
  const applyPromoCode = async () => {
    const code = promoCode.toUpperCase().trim()
    if (!code) return
    setIsApplyingPromo(true)
    try {
      const q   = query(collection(db, 'discountCodes'), where('code', '==', code), where('isActive', '==', true))
      const snap = await getDocs(q)
      if (snap.empty) { alert('Kode tidak valid atau tidak aktif'); return }
      const cd  = snap.docs[0].data()
      const now = new Date().toISOString().slice(0, 10)
      if (cd.startDate && cd.startDate > now)         { alert('Kode belum berlaku'); return }
      if (cd.endDate   && cd.endDate   < now)         { alert('Kode sudah kadaluarsa'); return }
      if (cd.usageLimit && cd.usageCount >= cd.usageLimit) { alert('Kode sudah habis'); return }
      if (cd.minPurchase && subtotal < cd.minPurchase)
        { alert(`Min. pembelian ${BRAND.currency.format(cd.minPurchase)}`); return }
      setAppliedPromoCode({ code: cd.code, value: cd.value, type: cd.type })
      setPromoCode('')
      setActiveAdjustment(null)
    } catch { alert('Gagal mengecek kode.') }
    finally { setIsApplyingPromo(false) }
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
      setDiscountInputStr('')
      setAppliedPromoCode(null)
      setPromoCode('')
      setActiveAdjustment(null)
      setIsCheckoutOpen(false)
      setIsSuccessOpen(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`Gagal menyimpan transaksi.\n\nDetail: ${msg}`)
      console.error('Transaction error:', err)
    } finally { setIsProcessing(false) }
  }

  // ── Clear cart ────────────────────────────────────────────
  const handleClearCart = () => {
    setCart([])
    setSelectedCustomer(null)
    setCustomerSearch('')
    setOrderNotes('')
    setDiscountRunning(0)
    setDiscountInputStr('')
    setAppliedPromoCode(null)
    setPromoCode('')
    setActiveAdjustment(null)
  }

  const handleSeed = async () => { alert(await seedDatabase()) }

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
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">

      {/* ── HEADER ─────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-8 flex items-center justify-center">
            <img src={BRAND.logoUrl} alt="Mandalika" className="w-full h-full object-contain" />
          </div>
          <div>
            <p className="text-sm font-black text-gray-900">{BRAND.name} POS</p>
            <p className="text-xs text-gray-400">Kasir</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative p-2">
            <ShoppingCart className="w-5 h-5 text-gray-400" />
            {totalCartItems > 0 && (
              <span className="absolute top-0 right-0 w-4 h-4 bg-indigo-600 text-white text-xs font-bold rounded-full flex items-center justify-center">
                {totalCartItems}
              </span>
            )}
          </div>
          <div className="text-right hidden sm:block px-2">
            <p className="text-sm font-bold text-gray-900">{appUser.displayName}</p>
            <p className="text-xs text-gray-400 capitalize">{appUser.role}</p>
          </div>
          <button onClick={() => setIsHistoryOpen(true)}
            className="p-2 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all"
            title="Riwayat Transaksi">
            <History className="w-5 h-5" />
          </button>
          {appUser.role === 'admin' && (
            <button onClick={handleSeed}
              className="p-2 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all"
              title="Isi Data">
              <Database className="w-5 h-5" />
            </button>
          )}
          <button onClick={onLogout}
            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ── MAIN AREA ──────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT: Product Grid ───────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Search + Filter bar */}
          <div className="bg-white border-b border-gray-200 px-4 py-3 space-y-3 flex-shrink-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cari produk..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
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
              <button
                onClick={() => setSelectedCategoryId(null)}
                className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${
                  !selectedCategoryId
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                Semua
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategoryId(cat.id!)}
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
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col flex-shrink-0">

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
                  className="w-full pl-8 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
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

              {/* Toolbar buttons */}
              <div className="flex items-center px-4 py-2 gap-1">
                {[
                  {
                    id:    'notes' as const,
                    icon:  <FileText className="w-3.5 h-3.5" />,
                    label: 'Catatan',
                    badge: orderNotes.trim() ? '✓' : undefined,
                  },
                  {
                    id:    'discount' as const,
                    icon:  <Tag className="w-3.5 h-3.5" />,
                    label: 'Diskon',
                    badge: discountAmount > 0 ? `-${Math.round(discountAmount / 1000)}k` : undefined,
                  },
                  {
                    id:    'promo' as const,
                    icon:  <Gift className="w-3.5 h-3.5" />,
                    label: 'Promo',
                    badge: appliedPromoCode ? '✓' : undefined,
                  },
                ].map(btn => (
                  <button
                    key={btn.id}
                    onClick={() => setActiveAdjustment(prev => prev === btn.id ? null : btn.id)}
                    className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 px-2 rounded-xl text-xs font-bold transition-all ${
                      activeAdjustment === btn.id
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'text-gray-400 hover:bg-gray-50 hover:text-gray-600'
                    }`}>
                    <span className="relative">
                      {btn.icon}
                      {btn.badge && (
                        <span className="absolute -top-1 -right-2 text-[9px] font-black text-green-600">
                          {btn.badge}
                        </span>
                      )}
                    </span>
                    <span>{btn.label}</span>
                  </button>
                ))}
              </div>

              {/* Notes panel */}
              {activeAdjustment === 'notes' && (
                <div className="px-4 pb-3">
                  <textarea
                    value={orderNotes}
                    onChange={e => setOrderNotes(e.target.value)}
                    placeholder="Catatan transaksi..."
                    rows={2}
                    className="w-full px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-xl text-xs resize-none focus:outline-none focus:ring-2 focus:ring-yellow-300"
                  />
                </div>
              )}

              {/* Discount panel */}
              {activeAdjustment === 'discount' && (
                <div className="px-4 pb-3 space-y-2">
                  {/* Type toggle */}
                  <div className="flex gap-2">
                    {(['fixed', 'percentage'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => { setDiscountType(t); setDiscountRunning(0); setDiscountInputStr('') }}
                        className={`flex-1 py-1.5 text-xs font-bold rounded-xl border-2 transition-all ${
                          discountType === t
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                            : 'border-gray-200 text-gray-500'}`}>
                        {t === 'fixed' ? 'Rp Nominal' : '% Persen'}
                      </button>
                    ))}
                  </div>

                  {/* Input + +/- buttons */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={discountInputStr}
                      onChange={e => setDiscountInputStr(e.target.value)}
                      placeholder={discountType === 'fixed' ? '50000' : '10'}
                      className="flex-1 px-2.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 text-center"
                    />
                    <button
                      onClick={() => applyDiscountAdjustment(-1)}
                      className="w-8 h-8 flex items-center justify-center bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-lg transition-all">
                      <Minus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => applyDiscountAdjustment(1)}
                      className="w-8 h-8 flex items-center justify-center bg-green-50 hover:bg-green-100 text-green-700 rounded-xl font-black text-lg transition-all">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Running total display */}
                  {discountRunning > 0 && (
                    <div className="flex items-center justify-between bg-green-50 rounded-xl px-3 py-2">
                      <span className="text-xs font-bold text-green-700">
                        Diskon: {discountType === 'percentage'
                          ? `${discountRunning}% (${BRAND.currency.format(manualDiscountAmount)})`
                          : BRAND.currency.format(discountRunning)}
                      </span>
                      <button
                        onClick={() => { setDiscountRunning(0); setDiscountInputStr('') }}
                        className="text-xs text-red-400 hover:text-red-600 font-bold">
                        Hapus
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Promo code panel */}
              {activeAdjustment === 'promo' && (
                <div className="px-4 pb-3 space-y-2">
                  {appliedPromoCode ? (
                    <div className="flex items-center justify-between bg-green-50 rounded-xl px-3 py-2">
                      <div>
                        <p className="text-xs font-black text-green-800 tracking-wider">{appliedPromoCode.code}</p>
                        <p className="text-xs text-green-600">
                          {appliedPromoCode.type === 'percentage'
                            ? `${appliedPromoCode.value}% (${BRAND.currency.format(promoDiscountAmount)})`
                            : BRAND.currency.format(promoDiscountAmount)} diskon
                        </p>
                      </div>
                      <button
                        onClick={() => setAppliedPromoCode(null)}
                        className="text-green-400 hover:text-red-500 transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={promoCode}
                        onChange={e => setPromoCode(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && applyPromoCode()}
                        placeholder="Kode promo..."
                        className="flex-1 px-2.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-indigo-500 uppercase"
                      />
                      <button
                        onClick={applyPromoCode}
                        disabled={isApplyingPromo || !promoCode.trim()}
                        className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-xs font-bold rounded-xl transition-all flex items-center gap-1">
                        {isApplyingPromo ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Pakai'}
                      </button>
                    </div>
                  )}
                </div>
              )}
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
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all active:scale-[0.98] shadow-lg shadow-indigo-100 text-sm">
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
      {/* VARIANT POP-UP MODAL                              */}
      {/* ══════════════════════════════════════════════════ */}
      {selectedProductForCart && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">

            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
              <div className="w-12 h-12 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0">
                {selectedProductForCart.imageUrl
                  ? <img src={selectedProductForCart.imageUrl} alt={selectedProductForCart.name}
                      className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center">
                      <Package className="w-5 h-5 text-gray-300" />
                    </div>}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-black text-gray-900 text-sm leading-tight">{selectedProductForCart.name}</p>
                <p className="text-xs text-gray-400">{selectedProductForCart.brand}</p>
              </div>
              <button
                onClick={() => setSelectedProductForCart(null)}
                className="p-2 hover:bg-gray-100 rounded-xl flex-shrink-0">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Variants */}
            <div className="p-4 space-y-2 max-h-72 overflow-y-auto">
              {selectedProductForCart.variants.map(variant => {
                const qty = variantQtys[variant.size] || 0
                const isOut = variant.stock === 0
                return (
                  <div key={variant.size}
                    className={`flex items-center justify-between p-3 rounded-2xl border-2 transition-all ${
                      qty > 0
                        ? 'border-indigo-400 bg-indigo-50'
                        : isOut
                          ? 'border-gray-100 bg-gray-50 opacity-60'
                          : 'border-gray-100 bg-white'}`}>
                    <div>
                      <p className={`font-black text-sm ${qty > 0 ? 'text-indigo-800' : 'text-gray-800'}`}>
                        {variant.size}
                      </p>
                      <p className={`text-xs font-bold ${qty > 0 ? 'text-indigo-600' : 'text-indigo-500'}`}>
                        {BRAND.currency.format(variant.price)}
                      </p>
                      <p className={`text-xs ${variant.stock <= 5 ? 'text-red-500' : 'text-gray-400'}`}>
                        Stok: {variant.stock}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleVariantQtyChange(variant.size, -1)}
                        disabled={qty === 0}
                        className="w-8 h-8 rounded-xl bg-white border-2 border-gray-200 hover:border-indigo-400 disabled:opacity-30 text-gray-700 font-black flex items-center justify-center transition-all">
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className={`w-7 text-center font-black text-base ${qty > 0 ? 'text-indigo-700' : 'text-gray-400'}`}>
                        {qty}
                      </span>
                      <button
                        onClick={() => handleVariantQtyChange(variant.size, 1)}
                        disabled={isOut || qty >= variant.stock}
                        className="w-8 h-8 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white font-black flex items-center justify-center transition-all">
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Confirm */}
            <div className="px-4 pb-4">
              <button
                onClick={handleConfirmVariants}
                disabled={totalVariantsSelected === 0}
                className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all flex items-center justify-center gap-2 text-sm">
                {totalVariantsSelected === 0
                  ? 'Pilih varian'
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
                      <span>Diskon{appliedPromoCode ? ` (${appliedPromoCode.code})` : ''}</span>
                      <span>-{BRAND.currency.format(discountAmount)}</span>
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
                          className="py-2 px-2 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 text-gray-600 text-xs font-bold rounded-xl transition-all">
                          {BRAND.currency.format(amount)}
                        </button>
                      ))}
                  </div>
                  <input
                    type="number"
                    placeholder="Masukkan jumlah..."
                    value={amountPaid}
                    onChange={e => setAmountPaid(e.target.value)}
                    className="w-full p-3 bg-gray-50 border-2 border-gray-200 focus:border-indigo-500 rounded-xl font-bold text-lg focus:outline-none"
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
                  {historyOrders.length} transaksi ·{' '}
                  Total:{' '}
                  {BRAND.currency.format(
                    historyOrders.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0)
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
              ) : (
                <div className="divide-y divide-gray-50">
                  {historyOrders.map(order => (
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
              )}
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
    updated[index].quantity += delta
    if (updated[index].quantity <= 0) {
      updated.splice(index, 1)
    } else {
      updated[index].subtotal = updated[index].quantity * updated[index].price
    }
    setCart(updated)
  }

  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{item.productName}</p>
          <p className="text-xs text-gray-400">{item.variantSize} · {BRAND.currency.format(item.price)}</p>
        </div>
        <button
          onClick={() => updateQty(-item.quantity)}
          className="text-gray-300 hover:text-red-500 transition-colors text-xs flex-shrink-0">
          ✕
        </button>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => updateQty(-1)}
            className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-100 flex items-center justify-center">
            −
          </button>
          <span className="w-6 text-center text-sm font-black text-gray-900">{item.quantity}</span>
          <button
            onClick={() => updateQty(1)}
            className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-100 flex items-center justify-center">
            +
          </button>
        </div>
        <p className="text-sm font-black text-gray-900">{BRAND.currency.format(item.subtotal)}</p>
      </div>
    </div>
  )
}