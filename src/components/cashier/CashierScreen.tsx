import { useState, useEffect, useRef } from 'react'
import type { AppUser, Product, Category, CartItem, Order, Customer, LoyaltySettings, AppSettings } from '../../types'
import { PaymentMethod, OrderStatus } from '../../types'
import { db } from '../../firebase'
import { collection, onSnapshot, addDoc, doc, getDoc, updateDoc, query, orderBy, where } from 'firebase/firestore'
import { BRAND } from '../../config/brand'
import {
  Search, ShoppingCart, LogOut, Package, Database, X, CheckCircle,
  Banknote, CreditCard, Smartphone, ArrowLeftRight, History, ChevronDown,
  ChevronUp, User, Tag, FileText, Percent, Minus, Heart, UserPlus, Plus, Loader2
} from 'lucide-react'
import { seedDatabase } from '../../lib/seedData'
import { format, parseISO, isToday } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

interface Props { appUser: AppUser; onLogout: () => void }

function generateOrderNumber(): string {
  return `MND-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(Math.random()*9000)+1000}`
}

const DEFAULT_LOYALTY: LoyaltySettings = { enabled: true, tierEnabled: true, pointsPerThousand: 1, redemptionRate: 100 }
const DEFAULT_SETTINGS: AppSettings = {
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

export default function CashierScreen({ appUser, onLogout }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [allUsers, setAllUsers] = useState<AppUser[]>([])
  const [loyalty, setLoyalty] = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [isLoadingProducts, setIsLoadingProducts] = useState(true)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [showFavouritesOnly, setShowFavouritesOnly] = useState(false)
  const [cart, setCart] = useState<CartItem[]>([])

  // Customer
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [customerSearch, setCustomerSearch] = useState('')
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false)
  const [isAddingCustomer, setIsAddingCustomer] = useState(false)
  const [newCustomerForm, setNewCustomerForm] = useState({ name: '', phone: '', email: '' })
  const [isSavingCustomer, setIsSavingCustomer] = useState(false)
  const customerRef = useRef<HTMLDivElement>(null)

  // Order adjustments
  const [orderNotes, setOrderNotes] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>('fixed')
  const [discountValue, setDiscountValue] = useState('')

  // Checkout
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false)
  const [isSuccessOpen, setIsSuccessOpen] = useState(false)
  const [lastOrder, setLastOrder] = useState<Order | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PaymentMethod.CASH)
  const [amountPaid, setAmountPaid] = useState('')
  const [selectedSalesman, setSelectedSalesman] = useState<AppUser | null>(null)

  // History
  const [isHistoryOpen, setIsHistoryOpen] = useState(false)
  const [historyOrders, setHistoryOrders] = useState<Order[]>([])
  const [historyExpanded, setHistoryExpanded] = useState<string | null>(null)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'products'), s => {
      setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive))
      setIsLoadingProducts(false)
    })
    const u2 = onSnapshot(collection(db, 'categories'), s => setCategories(s.docs.map(d => ({ id: d.id, ...d.data() } as Category))))
    const u3 = onSnapshot(collection(db, 'customers'), s => setCustomers(s.docs.map(d => ({ id: d.id, ...d.data() } as Customer))))
    const u4 = onSnapshot(collection(db, 'users'), s => setAllUsers(s.docs.map(d => ({ id: d.id, ...d.data() } as AppUser))))
    const u5 = onSnapshot(doc(db, 'settings', 'loyalty'), s => { if (s.exists()) setLoyalty(s.data() as LoyaltySettings) })
    const u6 = onSnapshot(doc(db, 'settings', 'app'), s => { if (s.exists()) setSettings({ ...DEFAULT_SETTINGS, ...s.data() as AppSettings }) })
    return () => { u1(); u2(); u3(); u4(); u5(); u6() }
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerRef.current && !customerRef.current.contains(e.target as Node)) setShowCustomerDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Computed
  const filteredProducts = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchCat = !selectedCategoryId || p.categoryId === selectedCategoryId
    const matchFav = !showFavouritesOnly || p.isFavourite
    return matchSearch && matchCat && matchFav
  })

  const subtotal = cart.reduce((s, i) => s + i.subtotal, 0)
  const discountAmount = discountOpen && discountValue
    ? discountType === 'percentage'
      ? Math.round(subtotal * (parseFloat(discountValue) / 100))
      : Math.min(parseFloat(discountValue) || 0, subtotal)
    : 0
  const taxableAmount = subtotal - discountAmount
  const taxAmount = settings.taxEnabled ? Math.round(taxableAmount * (settings.taxRate / 100)) : 0
  let total = taxableAmount + taxAmount
  if (settings.roundingEnabled) {
    const roundTo = settings.roundingType === 'nearest_1000' ? 1000 : settings.roundingType === 'nearest_500' ? 500 : 1
    total = Math.round(total / roundTo) * roundTo
  }
  const paid = parseFloat(amountPaid.replace(/\./g, '')) || 0
  const change = Math.max(0, paid - total)
  const totalCartItems = cart.reduce((s, i) => s + i.quantity, 0)
  const filteredCustomers = customerSearch.length >= 2
    ? customers.filter(c => c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)).slice(0, 5)
    : []
  const earnedPoints = loyalty.enabled && selectedCustomer ? Math.floor(total / 1000) * loyalty.pointsPerThousand : 0
  const getTier = (spent: number) => spent >= 5000000 ? 'Platinum' : spent >= 2000000 ? 'Gold' : spent >= 500000 ? 'Silver' : 'Member'
  const enabledPaymentMethods = settings.paymentMethods.filter(p => p.isEnabled)

  // Cart helpers
  const addToCart = (product: Product, variantIndex: number) => {
    const variant = product.variants[variantIndex]
    const existingIndex = cart.findIndex(i => i.productId === product.id && i.variantSize === variant.size)
    if (existingIndex >= 0) {
      const updated = [...cart]
      updated[existingIndex].quantity += 1
      updated[existingIndex].subtotal = updated[existingIndex].quantity * updated[existingIndex].price
      setCart(updated)
    } else {
      setCart([...cart, { productId: product.id!, productName: product.name, variantSize: variant.size, price: variant.price, quantity: 1, subtotal: variant.price }])
    }
  }

  const toggleFavourite = async (product: Product) => {
    if (!product.id) return
    await updateDoc(doc(db, 'products', product.id), { isFavourite: !product.isFavourite })
  }

  const handleAddNewCustomer = async () => {
    if (!newCustomerForm.name.trim() || !newCustomerForm.phone.trim()) { alert('Nama dan telepon wajib diisi'); return }
    setIsSavingCustomer(true)
    try {
      const newCustomer = { name: newCustomerForm.name.trim(), phone: newCustomerForm.phone.trim(), email: newCustomerForm.email.trim(), points: 0, totalSpent: 0, visitCount: 0, createdAt: new Date().toISOString() }
      const ref = await addDoc(collection(db, 'customers'), newCustomer)
      setSelectedCustomer({ id: ref.id, ...newCustomer })
      setIsAddingCustomer(false)
      setNewCustomerForm({ name: '', phone: '', email: '' })
      setCustomerSearch('')
    } catch { alert('Gagal menambahkan pelanggan.') }
    finally { setIsSavingCustomer(false) }
  }

  const openHistory = () => {
    setIsHistoryOpen(true)
    setIsLoadingHistory(true)
    const q = query(collection(db, 'orders'), where('cashierId', '==', appUser.uid), orderBy('createdAt', 'desc'))
    onSnapshot(q, s => {
      setHistoryOrders(s.docs.map(d => ({ id: d.id, ...d.data() } as Order)).filter(o => isToday(parseISO(o.createdAt))))
      setIsLoadingHistory(false)
    })
  }

  const openCheckout = () => {
    setPaymentMethod(enabledPaymentMethods[0]?.id as PaymentMethod || PaymentMethod.CASH)
    setAmountPaid('')
    setSelectedSalesman(null)
    setIsCheckoutOpen(true)
  }

  const handleConfirmPayment = async () => {
    if (paymentMethod === PaymentMethod.CASH && paid < total) { alert('Jumlah bayar kurang!'); return }
    setIsProcessing(true)
    try {
      const order: Omit<Order, 'id'> = {
        orderNumber: generateOrderNumber(),
        outletId: 'default',
        cashierId: appUser.uid,
        cashierName: appUser.displayName,
        salesmanId: selectedSalesman?.uid,
        salesmanName: selectedSalesman?.displayName,
        customerId: selectedCustomer?.id,
        customerName: selectedCustomer?.name,
        items: cart,
        subtotal,
        discountAmount,
        discountType: discountOpen ? discountType : undefined,
        discountValue: discountOpen ? parseFloat(discountValue) || 0 : undefined,
        taxAmount,
        total,
        paymentMethod,
        amountPaid: paymentMethod === PaymentMethod.CASH ? paid : total,
        change: paymentMethod === PaymentMethod.CASH ? change : 0,
        status: OrderStatus.COMPLETED,
        notes: orderNotes.trim() || undefined,
        createdAt: new Date().toISOString(),
      }
      const ref = await addDoc(collection(db, 'orders'), order)

      for (const item of cart) {
        const ps = await getDoc(doc(db, 'products', item.productId))
        if (ps.exists()) {
          const data = ps.data() as Product
          await updateDoc(doc(db, 'products', item.productId), {
            variants: data.variants.map(v => v.size === item.variantSize ? { ...v, stock: Math.max(0, v.stock - item.quantity) } : v)
          })
        }
      }

      if (selectedCustomer?.id) {
        await updateDoc(doc(db, 'customers', selectedCustomer.id), {
          totalSpent: selectedCustomer.totalSpent + total,
          visitCount: selectedCustomer.visitCount + 1,
          lastVisit: new Date().toISOString(),
          points: selectedCustomer.points + earnedPoints,
        })
      }

      setLastOrder({ id: ref.id, ...order })
      setCart([]); setSelectedCustomer(null); setCustomerSearch('')
      setOrderNotes(''); setDiscountValue(''); setDiscountOpen(false); setNotesOpen(false)
      setIsCheckoutOpen(false); setIsSuccessOpen(true)
    } catch (err) { alert('Gagal menyimpan transaksi.'); console.error(err) }
    finally { setIsProcessing(false) }
  }

  const handleSeed = async () => { alert(await seedDatabase()) }

  const paymentIcons: Record<string, React.ReactNode> = {
    cash: <Banknote className="w-4 h-4" />,
    card: <CreditCard className="w-4 h-4" />,
    qris: <Smartphone className="w-4 h-4" />,
    transfer: <ArrowLeftRight className="w-4 h-4" />
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden">

      {/* HEADER */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center">
            <span className="text-sm font-black text-white">{BRAND.logo}</span>
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
          <button onClick={openHistory} className="p-2 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all" title="Riwayat">
            <History className="w-5 h-5" />
          </button>
          {appUser.role === 'admin' && (
            <button onClick={handleSeed} className="p-2 text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-xl transition-all" title="Isi Data">
              <Database className="w-5 h-5" />
            </button>
          )}
          <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* LEFT: Products */}
        <div className="flex-1 flex flex-col overflow-hidden">
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
                className={`p-2.5 rounded-xl border-2 transition-all ${showFavouritesOnly ? 'border-red-400 bg-red-50 text-red-500' : 'border-gray-200 text-gray-400 hover:border-red-300'}`}
                title="Tampilkan favorit"
              >
                <Heart className={`w-4 h-4 ${showFavouritesOnly ? 'fill-current' : ''}`} />
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                onClick={() => setSelectedCategoryId(null)}
                className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${!selectedCategoryId ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              >
                Semua
              </button>
              {categories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategoryId(cat.id!)}
                  className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-all flex-shrink-0 ${selectedCategoryId === cat.id ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {isLoadingProducts ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="bg-white rounded-2xl p-4 animate-pulse">
                    <div className="w-full h-32 bg-gray-200 rounded-xl mb-3" />
                    <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
                  </div>
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
                <Package className="w-12 h-12" />
                <p className="font-bold">{showFavouritesOnly ? 'Belum ada produk favorit' : 'Produk tidak ditemukan'}</p>
                {showFavouritesOnly && <p className="text-sm text-center">Klik ikon ❤ di kartu produk untuk menambahkan ke favorit</p>}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {filteredProducts.map(product => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onAddToCart={addToCart}
                    onToggleFavourite={toggleFavourite}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Cart */}
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col flex-shrink-0">

          {/* Customer Section */}
          <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex-shrink-0" ref={customerRef}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest">Pelanggan</p>
              {!selectedCustomer && !isAddingCustomer && (
                <button
                  onClick={() => setIsAddingCustomer(true)}
                  className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700"
                >
                  <UserPlus className="w-3 h-3" /> Baru
                </button>
              )}
            </div>

            {isAddingCustomer ? (
              <div className="space-y-2">
                <p className="text-xs font-bold text-indigo-700">Tambah Pelanggan Baru</p>
                <input
                  type="text"
                  value={newCustomerForm.name}
                  onChange={e => setNewCustomerForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Nama *"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="tel"
                  value={newCustomerForm.phone}
                  onChange={e => setNewCustomerForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="No. Telepon *"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="email"
                  value={newCustomerForm.email}
                  onChange={e => setNewCustomerForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="Email (opsional)"
                  className="w-full px-2.5 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs focus:outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setIsAddingCustomer(false); setNewCustomerForm({ name: '', phone: '', email: '' }) }}
                    className="flex-1 py-1.5 border border-gray-200 text-gray-600 text-xs font-bold rounded-lg"
                  >
                    Batal
                  </button>
                  <button
                    onClick={handleAddNewCustomer}
                    disabled={isSavingCustomer}
                    className="flex-1 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1"
                  >
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
                  className="text-indigo-400 hover:text-red-500"
                >
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
                {showCustomerDropdown && filteredCustomers.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                    {filteredCustomers.map(c => (
                      <button
                        key={c.id}
                        onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); setShowCustomerDropdown(false) }}
                        className="w-full px-3 py-2 text-left hover:bg-indigo-50 transition-all"
                      >
                        <p className="text-sm font-bold text-gray-900">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.phone}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Cart Header */}
          <div className="px-4 py-2 border-b border-gray-100 flex-shrink-0">
            <h2 className="font-black text-gray-900 text-sm">
              Keranjang {cart.length > 0 && <span className="text-indigo-600 ml-1">({totalCartItems})</span>}
            </h2>
          </div>

          {/* Cart Items */}
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

          {/* Adjustments */}
          {cart.length > 0 && (
            <div className="px-4 py-2 space-y-1.5 flex-shrink-0 border-t border-gray-100">
              <button
                onClick={() => setNotesOpen(!notesOpen)}
                className={`w-full flex items-center gap-2 py-1.5 px-3 rounded-xl text-xs font-bold transition-all ${notesOpen ? 'bg-yellow-50 text-yellow-700' : 'text-gray-400 hover:bg-gray-50'}`}
              >
                <FileText className="w-3.5 h-3.5" />
                Catatan{notesOpen && orderNotes && ' ✓'}
              </button>
              {notesOpen && (
                <textarea
                  value={orderNotes}
                  onChange={e => setOrderNotes(e.target.value)}
                  placeholder="Catatan transaksi..."
                  rows={2}
                  className="w-full px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-xl text-xs resize-none focus:outline-none"
                />
              )}
              <button
                onClick={() => { setDiscountOpen(!discountOpen); if (discountOpen) setDiscountValue('') }}
                className={`w-full flex items-center gap-2 py-1.5 px-3 rounded-xl text-xs font-bold transition-all ${discountOpen ? 'bg-green-50 text-green-700' : 'text-gray-400 hover:bg-gray-50'}`}
              >
                <Tag className="w-3.5 h-3.5" />
                Diskon{discountOpen && discountAmount > 0 && ` (-${BRAND.currency.format(discountAmount)})`}
              </button>
              {discountOpen && (
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    {[
                      { val: 'percentage', icon: <Percent className="w-3 h-3" />, label: 'Persen' },
                      { val: 'fixed', icon: <Minus className="w-3 h-3" />, label: 'Nominal' }
                    ].map(({ val, icon, label }) => (
                      <button
                        key={val}
                        onClick={() => setDiscountType(val as 'percentage' | 'fixed')}
                        className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-xs font-bold rounded-xl border-2 transition-all ${discountType === val ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-500'}`}
                      >
                        {icon} {label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    value={discountValue}
                    onChange={e => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? '10 (untuk 10%)' : '50000'}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
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
                <span>Diskon {discountType === 'percentage' ? `${discountValue}%` : ''}</span>
                <span>-{BRAND.currency.format(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-black text-gray-900 pt-1 border-t border-gray-100">
              <span>Total</span>
              <span className="text-indigo-600">{BRAND.currency.format(total)}</span>
            </div>
            <button
              onClick={openCheckout}
              disabled={cart.length === 0}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all active:scale-[0.98] shadow-lg shadow-indigo-100 text-sm"
            >
              {cart.length === 0 ? 'Keranjang Kosong' : `Bayar ${BRAND.currency.format(total)}`}
            </button>
            {cart.length > 0 && (
              <button
                onClick={() => {
                  setCart([]); setSelectedCustomer(null)
                  setDiscountValue(''); setDiscountOpen(false)
                  setOrderNotes(''); setNotesOpen(false)
                }}
                className="w-full py-1.5 text-xs font-bold text-gray-400 hover:text-red-500 transition-colors"
              >
                Kosongkan
              </button>
            )}
          </div>
        </div>
      </div>

      {/* CHECKOUT MODAL */}
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
                      <span>Diskon</span><span>-{BRAND.currency.format(discountAmount)}</span>
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

              {/* Salesman Selection */}
              <div>
                <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">
                  Salesman / SPG yang Melayani
                </p>
                <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto">
                  {allUsers.map(u => (
                    <button
                      key={u.id}
                      onClick={() => setSelectedSalesman(selectedSalesman?.uid === u.uid ? null : u)}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border-2 text-left transition-all ${selectedSalesman?.uid === u.uid ? 'border-indigo-600 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
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
                      className={`flex items-center gap-2 p-3 rounded-2xl border-2 font-bold text-sm transition-all ${paymentMethod === pm.id ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}
                    >
                      {paymentIcons[pm.id] || <Tag className="w-4 h-4" />} {pm.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cash Input */}
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
                          className="py-2 px-2 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 text-gray-600 text-xs font-bold rounded-xl transition-all"
                        >
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

              {/* Points Preview */}
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
                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-black rounded-2xl transition-all flex items-center justify-center gap-2"
              >
                {isProcessing
                  ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />Memproses...</>
                  : 'Konfirmasi Pembayaran'
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SUCCESS MODAL */}
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
              className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-2xl transition-all"
            >
              Transaksi Baru
            </button>
          </div>
        </div>
      )}

      {/* HISTORY MODAL */}
      {isHistoryOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">Riwayat Hari Ini</h2>
                <p className="text-xs text-gray-400">{historyOrders.length} transaksi</p>
              </div>
              <button onClick={() => setIsHistoryOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoadingHistory ? (
                <div className="p-8 text-center text-gray-300">Memuat...</div>
              ) : historyOrders.length === 0 ? (
                <div className="p-12 text-center text-gray-300">
                  <History className="w-12 h-12 mx-auto mb-3" />
                  <p>Belum ada transaksi hari ini</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {historyOrders.map(order => (
                    <div key={order.id}>
                      <div
                        className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-all"
                        onClick={() => setHistoryExpanded(historyExpanded === order.id ? null : order.id!)}
                      >
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${order.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                          <ShoppingCart className={`w-4 h-4 ${order.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                          <p className="text-xs text-gray-400">
                            {format(parseISO(order.createdAt), 'HH:mm', { locale: idLocale })}
                            {' · '}<span className="capitalize">{order.paymentMethod}</span>
                            {order.customerName && ` · ${order.customerName}`}
                            {order.salesmanName && ` · ${order.salesmanName}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`px-2 py-0.5 text-xs font-bold rounded-lg ${order.status === 'refunded' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                            {order.status === 'refunded' ? 'Refund' : 'Selesai'}
                          </span>
                          <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                          {historyExpanded === order.id
                            ? <ChevronUp className="w-4 h-4 text-gray-400" />
                            : <ChevronDown className="w-4 h-4 text-gray-400" />
                          }
                        </div>
                      </div>
                      {historyExpanded === order.id && (
                        <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                          <div className="pt-3 space-y-1">
                            {order.items.map((item, i) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                                <span className="font-bold">{BRAND.currency.format(item.subtotal)}</span>
                              </div>
                            ))}
                            <div className="border-t border-gray-200 pt-2 flex justify-between font-black text-gray-900">
                              <span>Total</span>
                              <span>{BRAND.currency.format(order.total)}</span>
                            </div>
                            {order.notes && (
                              <p className="text-xs text-gray-500 bg-yellow-50 rounded-lg px-2 py-1">📝 {order.notes}</p>
                            )}
                            {order.status === 'refunded' && order.refundReason && (
                              <p className="text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1">↩ {order.refundReason}</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {historyOrders.length > 0 && (
              <div className="border-t border-gray-100 px-6 py-4 flex justify-between items-center flex-shrink-0">
                <p className="text-sm font-bold text-gray-500">
                  {historyOrders.filter(o => o.status === 'completed').length} selesai
                </p>
                <p className="text-lg font-black text-indigo-600">
                  {BRAND.currency.format(
                    historyOrders.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0)
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

// ── Product Card ─────────────────────────
function ProductCard({
  product,
  onAddToCart,
  onToggleFavourite,
}: {
  product: Product
  onAddToCart: (p: Product, i: number) => void
  onToggleFavourite: (p: Product) => void
}) {
  const [selectedVariant, setSelectedVariant] = useState(0)
  const variant = product.variants[selectedVariant]

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all border border-gray-100 flex flex-col">
      <div className="w-full h-32 bg-gray-100 overflow-hidden relative">
        {product.imageUrl
          ? <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center"><Package className="w-8 h-8 text-gray-300" /></div>
        }
        <button
          onClick={e => { e.stopPropagation(); onToggleFavourite(product) }}
          className="absolute top-2 right-2 w-7 h-7 bg-white/90 rounded-full flex items-center justify-center shadow-sm hover:bg-white transition-all"
        >
          <Heart className={`w-4 h-4 ${product.isFavourite ? 'fill-red-500 text-red-500' : 'text-gray-400'}`} />
        </button>
      </div>
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div>
          <p className="font-bold text-gray-900 text-sm leading-tight">{product.name}</p>
          <p className="text-xs text-gray-400">{product.brand}</p>
        </div>
        {product.variants.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {product.variants.map((v, i) => (
              <button
                key={v.size}
                onClick={() => setSelectedVariant(i)}
                className={`px-2 py-0.5 rounded-lg text-xs font-bold transition-all ${selectedVariant === i ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              >
                {v.size}
              </button>
            ))}
          </div>
        )}
        <div>
          <p className="font-black text-indigo-600 text-sm">{BRAND.currency.format(variant.price)}</p>
          <p className={`text-xs font-medium ${variant.stock <= 5 ? 'text-red-500' : 'text-gray-400'}`}>
            Stok: {variant.stock}
          </p>
        </div>
        <button
          onClick={() => onAddToCart(product, selectedVariant)}
          disabled={variant.stock === 0}
          className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-xs font-bold rounded-xl transition-all active:scale-95 mt-auto"
        >
          {variant.stock === 0 ? 'Habis' : '+ Tambah'}
        </button>
      </div>
    </div>
  )
}

// ── Cart Item Row ────────────────────────
function CartItemRow({
  item,
  index,
  cart,
  setCart,
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
          className="text-gray-300 hover:text-red-500 transition-colors text-xs flex-shrink-0"
        >
          ✕
        </button>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => updateQty(-1)}
            className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-100 flex items-center justify-center"
          >
            −
          </button>
          <span className="w-6 text-center text-sm font-black text-gray-900">{item.quantity}</span>
          <button
            onClick={() => updateQty(1)}
            className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-600 text-sm font-bold hover:bg-gray-100 flex items-center justify-center"
          >
            +
          </button>
        </div>
        <p className="text-sm font-black text-gray-900">{BRAND.currency.format(item.subtotal)}</p>
      </div>
    </div>
  )
}