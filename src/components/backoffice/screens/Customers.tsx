import { useState, useEffect } from 'react'
import type { AppUser, Customer, Order, LoyaltySettings, LoyaltyCondition, Product } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, where, orderBy, setDoc } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Search, Edit2, Trash2, X, Users, Phone, Mail, Star, Loader2, ChevronDown, ChevronUp, ShoppingBag, Settings2, ToggleLeft, ToggleRight, Gift } from 'lucide-react'

interface Props { appUser?: AppUser }

const DEFAULT_LOYALTY: LoyaltySettings = { enabled: true, tierEnabled: true, pointsPerThousand: 1, redemptionRate: 100 }
const EMPTY_CUSTOMER = { name: '', phone: '', email: '' }
const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']

const TRIGGER_OPTIONS = [
  { value: 'first_registration', label: 'Registrasi Pertama' },
  { value: 'birthday', label: 'Ulang Tahun Member' },
  { value: 'anniversary', label: 'Hari Jadi Member' },
  { value: 'double_date', label: 'Double Date (tgl = bln)' },
  { value: 'member_day', label: 'Member Day (hari tertentu)' },
  { value: 'product_purchase', label: 'Pembelian Produk Tertentu' },
  { value: 'spending_threshold', label: 'Capai Target Belanja' },
]

const REWARD_OPTIONS = [
  { value: 'set_points', label: 'Set Poin (langsung diberi)' },
  { value: 'multiply_points', label: 'Pengali Poin (multiplier)' },
  { value: 'product_reward', label: 'Reward Produk Gratis' },
]

const EMPTY_CONDITION: Omit<LoyaltyCondition, 'id' | 'createdAt'> = {
  name: '', type: 'always_on', trigger: 'first_registration',
  rewardType: 'set_points', rewardValue: 0, isActive: true,
  activeDays: [], applicableProductIds: [], rewardProductIds: [],
}

export default function Customers({ appUser: _appUser }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loyalty, setLoyalty] = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  const [conditions, setConditions] = useState<LoyaltyCondition[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'customers' | 'settings'>('customers')
  const [loyaltySubTab, setLoyaltySubTab] = useState<'general' | 'conditions'>('general')

  // Customer modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [formData, setFormData] = useState(EMPTY_CUSTOMER)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // History modal
  const [historyCustomer, setHistoryCustomer] = useState<Customer | null>(null)
  const [historyOrders, setHistoryOrders] = useState<Order[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState<string | null>(null)

  // Loyalty settings
  const [loyaltyForm, setLoyaltyForm] = useState(DEFAULT_LOYALTY)
  const [isSavingLoyalty, setIsSavingLoyalty] = useState(false)

  // Condition modal
  const [isCondModalOpen, setIsCondModalOpen] = useState(false)
  const [editingCond, setEditingCond] = useState<LoyaltyCondition | null>(null)
  const [condForm, setCondForm] = useState<Omit<LoyaltyCondition, 'id' | 'createdAt'>>(EMPTY_CONDITION)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'customers'), snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer))
      data.sort((a, b) => b.totalSpent - a.totalSpent)
      setCustomers(data)
      setIsLoading(false)
    })
    const unsubLoyalty = onSnapshot(doc(db, 'settings', 'loyalty'), snap => {
      if (snap.exists()) { setLoyalty(snap.data() as LoyaltySettings); setLoyaltyForm(snap.data() as LoyaltySettings) }
    })
    const unsubCond = onSnapshot(collection(db, 'loyaltyConditions'), snap => {
      setConditions(snap.docs.map(d => ({ id: d.id, ...d.data() } as LoyaltyCondition)))
    })
    const unsubProd = onSnapshot(collection(db, 'products'), snap => {
      setProducts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive))
    })
    return () => { unsub(); unsubLoyalty(); unsubCond(); unsubProd() }
  }, [])

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.phone.includes(searchQuery) ||
    (c.email || '').toLowerCase().includes(searchQuery.toLowerCase())
  )

  const openAdd = () => { setEditingCustomer(null); setFormData(EMPTY_CUSTOMER); setIsModalOpen(true) }
  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer)
    setFormData({ name: customer.name, phone: customer.phone, email: customer.email || '' })
    setIsModalOpen(true)
  }

  const handleSave = async () => {
    if (!formData.name.trim()) { alert('Nama pelanggan wajib diisi'); return }
    if (!formData.phone.trim()) { alert('No. telepon wajib diisi'); return }
    setIsSubmitting(true)
    try {
      if (editingCustomer?.id) {
        await updateDoc(doc(db, 'customers', editingCustomer.id), {
          name: formData.name.trim(), phone: formData.phone.trim(), email: formData.email.trim()
        })
      } else {
        const newCustomer: Omit<Customer, 'id'> = {
          name: formData.name.trim(), phone: formData.phone.trim(),
          email: formData.email.trim(), points: 0, totalSpent: 0,
          visitCount: 0, createdAt: new Date().toISOString()
        }
        await addDoc(collection(db, 'customers'), newCustomer)
      }
      setIsModalOpen(false)
    } catch { alert('Gagal menyimpan pelanggan.') }
    finally { setIsSubmitting(false) }
  }

  const handleDelete = async (id: string) => {
    try { await deleteDoc(doc(db, 'customers', id)); setDeleteConfirmId(null) }
    catch { alert('Gagal menghapus pelanggan.') }
  }

  const openHistory = async (customer: Customer) => {
    setHistoryCustomer(customer)
    setIsLoadingHistory(true)
    setHistoryOrders([])
    const q = query(collection(db, 'orders'), where('customerId', '==', customer.id), orderBy('createdAt', 'desc'))
    onSnapshot(q, snap => {
      setHistoryOrders(snap.docs.map(d => ({ id: d.id, ...d.data() } as Order)))
      setIsLoadingHistory(false)
    })
  }

  const saveLoyaltySettings = async () => {
    setIsSavingLoyalty(true)
    try { await setDoc(doc(db, 'settings', 'loyalty'), loyaltyForm); alert('Pengaturan loyalitas disimpan!') }
    catch { alert('Gagal menyimpan pengaturan.') }
    finally { setIsSavingLoyalty(false) }
  }

  // Condition CRUD
  const openAddCond = () => { setEditingCond(null); setCondForm({ ...EMPTY_CONDITION }); setIsCondModalOpen(true) }
  const openEditCond = (c: LoyaltyCondition) => {
    setEditingCond(c)
    setCondForm({ name: c.name, type: c.type, trigger: c.trigger, rewardType: c.rewardType, rewardValue: c.rewardValue, rewardProductIds: c.rewardProductIds || [], isActive: c.isActive, campaignStartDate: c.campaignStartDate, campaignEndDate: c.campaignEndDate, activeDays: c.activeDays || [], applicableProductIds: c.applicableProductIds || [], minimumSpend: c.minimumSpend })
    setIsCondModalOpen(true)
  }
  const saveCond = async () => {
    if (!condForm.name.trim()) { alert('Nama kondisi wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = { ...condForm, createdAt: editingCond?.createdAt || new Date().toISOString() }
      if (editingCond?.id) await updateDoc(doc(db, 'loyaltyConditions', editingCond.id), data)
      else await addDoc(collection(db, 'loyaltyConditions'), data)
      setIsCondModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }
  const toggleCondActive = async (c: LoyaltyCondition) => {
    if (!c.id) return
    await updateDoc(doc(db, 'loyaltyConditions', c.id), { isActive: !c.isActive })
  }

  const getTier = (spent: number) => {
    if (spent >= 5000000) return { label: 'Platinum', color: 'text-purple-600 bg-purple-50' }
    if (spent >= 2000000) return { label: 'Gold', color: 'text-yellow-600 bg-yellow-50' }
    if (spent >= 500000) return { label: 'Silver', color: 'text-gray-600 bg-gray-100' }
    return { label: 'Member', color: 'text-indigo-600 bg-indigo-50' }
  }

  return (
    <div className="p-6 space-y-5">

      {/* Header + Tabs */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pelanggan</h2>
          <p className="text-sm text-gray-400">{customers.length} pelanggan terdaftar</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            <button onClick={() => setActiveTab('customers')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === 'customers' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              Pelanggan
            </button>
            <button onClick={() => setActiveTab('settings')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === 'settings' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              <Settings2 className="w-3.5 h-3.5 inline mr-1" />Loyalitas
            </button>
          </div>
          {activeTab === 'customers' && (
            <button onClick={openAdd}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all text-sm shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Tambah
            </button>
          )}
          {activeTab === 'settings' && loyaltySubTab === 'conditions' && (
            <button onClick={openAddCond}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-all text-sm shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Tambah Kondisi
            </button>
          )}
        </div>
      </div>

      {activeTab === 'settings' ? (
        <div className="space-y-4">
          {/* Loyalty sub-tabs */}
          <div className="flex gap-2">
            <button onClick={() => setLoyaltySubTab('general')}
              className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${loyaltySubTab === 'general' ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
              Pengaturan Umum
            </button>
            <button onClick={() => setLoyaltySubTab('conditions')}
              className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${loyaltySubTab === 'conditions' ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
              Kondisi Khusus
            </button>
          </div>

          {loyaltySubTab === 'general' && (
            <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5 max-w-lg">
              <h3 className="font-black text-gray-900">Pengaturan Loyalitas</h3>
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Poin</p>
                  <p className="text-xs text-gray-400">Pelanggan mendapat poin setiap transaksi</p>
                </div>
                <button onClick={() => setLoyaltyForm(f => ({ ...f, enabled: !f.enabled }))} className="text-gray-400 hover:text-indigo-600 transition-colors">
                  {loyaltyForm.enabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
                </button>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Tier</p>
                  <p className="text-xs text-gray-400">Member / Silver / Gold / Platinum</p>
                </div>
                <button onClick={() => setLoyaltyForm(f => ({ ...f, tierEnabled: !f.tierEnabled }))} className="text-gray-400 hover:text-indigo-600 transition-colors">
                  {loyaltyForm.tierEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7" />}
                </button>
              </div>
              {loyaltyForm.enabled && (
                <>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Poin per Rp 1.000 belanja</label>
                    <input type="number" value={loyaltyForm.pointsPerThousand}
                      onChange={e => setLoyaltyForm(f => ({ ...f, pointsPerThousand: parseFloat(e.target.value) || 1 }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    <p className="text-xs text-gray-400 mt-1">Contoh: 1 berarti setiap Rp 1.000 → 1 poin</p>
                  </div>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Poin untuk Rp 1.000 diskon</label>
                    <input type="number" value={loyaltyForm.redemptionRate}
                      onChange={e => setLoyaltyForm(f => ({ ...f, redemptionRate: parseFloat(e.target.value) || 100 }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    <p className="text-xs text-gray-400 mt-1">Contoh: 100 berarti 100 poin → Rp 1.000 diskon</p>
                  </div>
                </>
              )}
              <div className="bg-indigo-50 rounded-xl p-3 text-xs text-indigo-700 space-y-1">
                <p className="font-bold">Tier saat ini:</p>
                <p>• Member: &lt; Rp 500.000</p>
                <p>• Silver: Rp 500.000 – 2.000.000</p>
                <p>• Gold: Rp 2.000.000 – 5.000.000</p>
                <p>• Platinum: &gt; Rp 5.000.000</p>
              </div>
              <button onClick={saveLoyaltySettings} disabled={isSavingLoyalty}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl transition-all flex items-center justify-center gap-2">
                {isSavingLoyalty ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan Pengaturan'}
              </button>
            </div>
          )}

          {loyaltySubTab === 'conditions' && (
            <div className="space-y-3">
              {/* Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4">
                  <p className="font-black text-indigo-900 text-sm mb-1">Always-On</p>
                  <p className="text-xs text-indigo-700">Kondisi yang selalu berlaku otomatis berdasarkan event member (registrasi, ulang tahun, dll.)</p>
                </div>
                <div className="bg-violet-50 border border-violet-100 rounded-2xl p-4">
                  <p className="font-black text-violet-900 text-sm mb-1">Campaign-Based</p>
                  <p className="text-xs text-violet-700">Kondisi berbasis periode campaign (double date, member day, produk tertentu)</p>
                </div>
              </div>

              {/* Conditions list */}
              {conditions.length === 0 ? (
                <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
                  <Gift className="w-12 h-12" /><p className="font-bold">Belum ada kondisi loyalitas</p>
                  <button onClick={openAddCond} className="mt-2 px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl text-sm">Tambah Kondisi</button>
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                  <div className="divide-y divide-gray-50">
                    {conditions.map(c => (
                      <div key={c.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50">
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 px-2 py-0.5 text-xs font-black rounded-full ${c.type === 'always_on' ? 'bg-indigo-100 text-indigo-700' : 'bg-violet-100 text-violet-700'}`}>
                            {c.type === 'always_on' ? 'Always-On' : 'Campaign'}
                          </span>
                          <div>
                            <p className="font-bold text-gray-900 text-sm">{c.name}</p>
                            <p className="text-xs text-gray-400">
                              {TRIGGER_OPTIONS.find(t => t.value === c.trigger)?.label} →{' '}
                              {c.rewardType === 'set_points' ? `+${c.rewardValue} Poin` : c.rewardType === 'multiply_points' ? `×${c.rewardValue} Poin` : 'Produk Gratis'}
                            </p>
                            {c.campaignStartDate && <p className="text-xs text-gray-400">{c.campaignStartDate} → {c.campaignEndDate || '∞'}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => toggleCondActive(c)}
                            className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                            {c.isActive ? 'Aktif' : 'Nonaktif'}
                          </button>
                          <button onClick={() => openEditCond(c)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                          <button onClick={async () => { if (c.id && confirm('Hapus kondisi ini?')) await deleteDoc(doc(db, 'loyaltyConditions', c.id)) }}
                            className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* CUSTOMERS LIST */
        <>
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Cari nama / telepon / email..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {isLoading ? <div className="p-8 text-center text-gray-300">Memuat...</div>
              : filtered.length === 0 ? (
                <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
                  <Users className="w-12 h-12" /><p className="font-bold">Tidak ada pelanggan</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Pelanggan</th>
                        <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden md:table-cell">Kontak</th>
                        <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Total Belanja</th>
                        {loyalty.enabled && <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Poin</th>}
                        {loyalty.tierEnabled && <th className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider hidden sm:table-cell">Tier</th>}
                        <th className="text-right px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filtered.map(customer => {
                        const tier = getTier(customer.totalSpent)
                        return (
                          <tr key={customer.id} className="hover:bg-gray-50 transition-all">
                            <td className="px-5 py-3">
                              <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                                  <span className="text-sm font-black text-indigo-600">{customer.name.charAt(0).toUpperCase()}</span>
                                </div>
                                <div>
                                  <p className="font-bold text-gray-900 text-sm">{customer.name}</p>
                                  <p className="text-xs text-gray-400">{customer.visitCount} kunjungan</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-5 py-3 hidden md:table-cell">
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5 text-xs text-gray-500"><Phone className="w-3 h-3" /> {customer.phone}</div>
                                {customer.email && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Mail className="w-3 h-3" /> {customer.email}</div>}
                              </div>
                            </td>
                            <td className="px-5 py-3">
                              <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(customer.totalSpent)}</p>
                            </td>
                            {loyalty.enabled && (
                              <td className="px-5 py-3 hidden sm:table-cell">
                                <div className="flex items-center gap-1 text-sm font-bold text-indigo-600">
                                  <Star className="w-3.5 h-3.5" />{customer.points.toLocaleString('id-ID')}
                                </div>
                              </td>
                            )}
                            {loyalty.tierEnabled && (
                              <td className="px-5 py-3 hidden sm:table-cell">
                                <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${tier.color}`}>{tier.label}</span>
                              </td>
                            )}
                            <td className="px-5 py-3">
                              <div className="flex items-center justify-end gap-1">
                                <button onClick={() => openHistory(customer)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl transition-all" title="Riwayat">
                                  <ShoppingBag className="w-4 h-4" />
                                </button>
                                <button onClick={() => openEdit(customer)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl transition-all">
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button onClick={() => setDeleteConfirmId(customer.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl transition-all">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </>
      )}

      {/* Customer History Modal */}
      {historyCustomer && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">Riwayat {historyCustomer.name}</h2>
                <p className="text-xs text-gray-400">Total: {BRAND.currency.format(historyCustomer.totalSpent)} · {historyCustomer.visitCount} kunjungan</p>
              </div>
              <button onClick={() => { setHistoryCustomer(null); setHistoryOrders([]) }} className="p-2 hover:bg-gray-100 rounded-xl">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isLoadingHistory ? <div className="p-8 text-center text-gray-300">Memuat...</div>
                : historyOrders.length === 0 ? (
                  <div className="p-12 text-center text-gray-300"><ShoppingBag className="w-12 h-12 mx-auto mb-3" /><p>Belum ada transaksi</p></div>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {historyOrders.map(order => (
                      <div key={order.id}>
                        <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer transition-all"
                          onClick={() => setHistoryExpanded(historyExpanded === order.id ? null : order.id!)}>
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${order.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                            <ShoppingBag className={`w-4 h-4 ${order.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-gray-900 text-sm">{order.orderNumber}</p>
                            <p className="text-xs text-gray-400">{format(parseISO(order.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · <span className="capitalize">{order.paymentMethod}</span></p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className={`px-2 py-0.5 text-xs font-bold rounded-lg ${order.status === 'refunded' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                              {order.status === 'refunded' ? 'Refund' : 'Selesai'}
                            </span>
                            <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(order.total)}</p>
                            {historyExpanded === order.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                          </div>
                        </div>
                        {historyExpanded === order.id && (
                          <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                            <div className="pt-3 space-y-1">
                              {order.items.map((item, i) => (
                                <div key={i} className="flex justify-between text-sm">
                                  <span className="text-gray-600">{item.productName} {item.variantSize} ×{item.quantity}</span>
                                  <span className="font-bold text-gray-900">{BRAND.currency.format(item.subtotal)}</span>
                                </div>
                              ))}
                              <div className="border-t border-gray-200 pt-2 flex justify-between font-black text-gray-900">
                                <span>Total</span><span>{BRAND.currency.format(order.total)}</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Customer Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingCustomer ? 'Edit Pelanggan' : 'Tambah Pelanggan'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              {[
                { label: 'Nama *', field: 'name', placeholder: 'Nama lengkap', type: 'text' },
                { label: 'No. Telepon *', field: 'phone', placeholder: '08xxxxxxxxxx', type: 'tel' },
                { label: 'Email', field: 'email', placeholder: 'email@contoh.com', type: 'email' },
              ].map(({ label, field, placeholder, type }) => (
                <div key={field}>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                  <input type={type} value={formData[field as keyof typeof formData]}
                    onChange={e => setFormData(f => ({ ...f, [field]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              ))}
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setIsModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={handleSave} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loyalty Condition Modal */}
      {isCondModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingCond ? 'Edit Kondisi' : 'Tambah Kondisi Loyalitas'}</h2>
              <button onClick={() => setIsCondModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Kondisi *</label>
                <input type="text" value={condForm.name} onChange={e => setCondForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Registrasi Pertama"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>

              {/* Type */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe Kondisi</label>
                <div className="grid grid-cols-2 gap-2">
                  {[{ val: 'always_on', label: 'Always-On', desc: 'Berlaku otomatis berdasarkan event', color: 'indigo' }, { val: 'campaign', label: 'Campaign-Based', desc: 'Berlaku dalam periode tertentu', color: 'violet' }].map(t => (
                    <button key={t.val} type="button" onClick={() => setCondForm(f => ({ ...f, type: t.val as any }))}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${condForm.type === t.val ? `border-${t.color}-500 bg-${t.color}-50` : 'border-gray-200'}`}>
                      <p className={`font-black text-sm ${condForm.type === t.val ? `text-${t.color}-700` : 'text-gray-700'}`}>{t.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Trigger */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Trigger / Pemicu</label>
                <select value={condForm.trigger} onChange={e => setCondForm(f => ({ ...f, trigger: e.target.value as any }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {TRIGGER_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {/* Member day picker */}
              {condForm.trigger === 'member_day' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Pilih Hari</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {DAYS_ID.map((day, i) => (
                      <button key={i} type="button"
                        onClick={() => setCondForm(f => ({ ...f, activeDays: (f.activeDays || []).includes(i) ? (f.activeDays || []).filter(d => d !== i) : [...(f.activeDays || []), i] }))}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-all ${(condForm.activeDays || []).includes(i) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600'}`}>
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Product picker for product_purchase trigger */}
              {condForm.trigger === 'product_purchase' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Produk yang Memicu</label>
                  <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
                    {products.map(p => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                        <input type="checkbox"
                          checked={(condForm.applicableProductIds || []).includes(p.id!)}
                          onChange={e => setCondForm(f => ({ ...f, applicableProductIds: e.target.checked ? [...(f.applicableProductIds || []), p.id!] : (f.applicableProductIds || []).filter(id => id !== p.id) }))}
                          className="accent-indigo-600" />
                        <span className="text-sm text-gray-700">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Spending threshold */}
              {condForm.trigger === 'spending_threshold' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Target Belanja (Rp)</label>
                  <input type="number" value={condForm.minimumSpend || ''} onChange={e => setCondForm(f => ({ ...f, minimumSpend: parseFloat(e.target.value) || 0 }))}
                    placeholder="Contoh: 500000"
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}

              {/* Reward type */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Reward</label>
                <select value={condForm.rewardType} onChange={e => setCondForm(f => ({ ...f, rewardType: e.target.value as any }))}
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {REWARD_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              {condForm.rewardType !== 'product_reward' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">
                    {condForm.rewardType === 'set_points' ? 'Jumlah Poin' : 'Pengali (×)'}
                  </label>
                  <input type="number" value={condForm.rewardValue} onChange={e => setCondForm(f => ({ ...f, rewardValue: parseFloat(e.target.value) || 0 }))}
                    placeholder={condForm.rewardType === 'set_points' ? 'Contoh: 100' : 'Contoh: 2 = 2x poin'}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}

              {condForm.rewardType === 'product_reward' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Produk Reward Gratis</label>
                  <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
                    {products.map(p => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                        <input type="checkbox"
                          checked={(condForm.rewardProductIds || []).includes(p.id!)}
                          onChange={e => setCondForm(f => ({ ...f, rewardProductIds: e.target.checked ? [...(f.rewardProductIds || []), p.id!] : (f.rewardProductIds || []).filter(id => id !== p.id) }))}
                          className="accent-indigo-600" />
                        <span className="text-sm text-gray-700">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Campaign date range */}
              {condForm.type === 'campaign' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Campaign Mulai</label>
                    <input type="date" value={condForm.campaignStartDate || ''} onChange={e => setCondForm(f => ({ ...f, campaignStartDate: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Campaign Berakhir</label>
                    <input type="date" value={condForm.campaignEndDate || ''} onChange={e => setCondForm(f => ({ ...f, campaignEndDate: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={condForm.isActive} onChange={e => setCondForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Kondisi Aktif</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setIsCondModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCond} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteConfirmId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Pelanggan?</h3>
            <p className="text-sm text-gray-400 mb-6">Data poin dan riwayat akan terhapus permanen.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={() => handleDelete(deleteConfirmId)} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
