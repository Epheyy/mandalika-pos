import { useState } from 'react'
import type {
  Customer,
  Order,
  LoyaltySettings,
  LoyaltyCondition,
  Product,
} from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import {
  Plus, Search, Edit2, Trash2, X, Users, Phone, Mail, Star, Loader2,
  ChevronDown, ChevronUp, ShoppingBag, Settings2, ToggleLeft, ToggleRight, Gift,
} from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { TableSkeleton } from '../components/Skeleton'
import { BRAND } from '../lib/brand'

const DEFAULT_LOYALTY: LoyaltySettings = {
  enabled: true,
  tierEnabled: true,
  pointsPerThousand: 1,
  redemptionRate: 100,
}
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
type CondForm = Omit<LoyaltyCondition, 'id' | 'createdAt'>
const EMPTY_COND: CondForm = {
  name: '', type: 'always_on', trigger: 'first_registration',
  rewardType: 'set_points', rewardValue: 0, isActive: true,
  activeDays: [], applicableProductIds: [], rewardProductIds: [],
}

export default function Customers() {
  const cq = usePolledQuery<Customer[]>(() => api.listCustomers().then((r) => r.data), [])
  const lq = usePolledQuery<LoyaltySettings>(() => api.getLoyaltySettings(), [])
  const condQ = usePolledQuery<LoyaltyCondition[]>(() => api.listLoyaltyConditions(), [])
  const pq = usePolledQuery<Product[]>(
    () => api.listProducts().then((r) => r.data.filter((p) => p.isActive)),
    [],
  )
  const customers = [...(cq.data ?? [])].sort((a, b) => b.totalSpent - a.totalSpent)
  const loyalty = lq.data ?? DEFAULT_LOYALTY
  const conditions = condQ.data ?? []
  const products = pq.data ?? []

  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'customers' | 'settings'>('customers')
  const [subTab, setSubTab] = useState<'general' | 'conditions'>('general')

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [delId, setDelId] = useState<string | null>(null)

  const [histCust, setHistCust] = useState<Customer | null>(null)
  const [histExpanded, setHistExpanded] = useState<string | null>(null)
  const histQ = usePolledQuery<Order[]>(
    () =>
      histCust
        ? api.listOrders({ customerId: histCust.id, limit: 200 }).then((r) => r.data)
        : Promise.resolve([]),
    [histCust?.id],
  )

  const [loyaltyForm, setLoyaltyForm] = useState<LoyaltySettings>(DEFAULT_LOYALTY)
  const [savingLoyalty, setSavingLoyalty] = useState(false)

  const [condOpen, setCondOpen] = useState(false)
  const [editingCond, setEditingCond] = useState<LoyaltyCondition | null>(null)
  const [condForm, setCondForm] = useState<CondForm>(EMPTY_COND)

  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) ||
      (c.email || '').toLowerCase().includes(search.toLowerCase()),
  )

  const saveCustomer = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      setErr('Nama & telepon wajib diisi')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const body = { name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() }
      if (editing) await api.updateCustomer(editing.id, body)
      else await api.createCustomer(body)
      setOpen(false)
      await cq.refetch()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan pelanggan.')
    } finally {
      setBusy(false)
    }
  }

  const del = async (cid: string) => {
    await api.deleteCustomer(cid)
    setDelId(null)
    await cq.refetch()
  }

  const saveLoyalty = async () => {
    setSavingLoyalty(true)
    try {
      await api.updateLoyaltySettings(loyaltyForm)
      await lq.refetch()
    } finally {
      setSavingLoyalty(false)
    }
  }

  const openEditCond = (c: LoyaltyCondition) => {
    setEditingCond(c)
    setCondForm({
      name: c.name, type: c.type, trigger: c.trigger, rewardType: c.rewardType,
      rewardValue: c.rewardValue, rewardProductIds: c.rewardProductIds || [],
      isActive: c.isActive, campaignStartDate: c.campaignStartDate,
      campaignEndDate: c.campaignEndDate, activeDays: c.activeDays || [],
      applicableProductIds: c.applicableProductIds || [], minimumSpend: c.minimumSpend,
    })
    setCondOpen(true)
  }
  const saveCond = async () => {
    if (!condForm.name.trim()) {
      setErr('Nama kondisi wajib diisi')
      return
    }
    setBusy(true)
    try {
      if (editingCond) await api.updateLoyaltyCondition(editingCond.id, condForm)
      else await api.createLoyaltyCondition(condForm)
      setCondOpen(false)
      await condQ.refetch()
    } finally {
      setBusy(false)
    }
  }
  const toggleCond = async (c: LoyaltyCondition) => {
    await api.updateLoyaltyCondition(c.id, { ...c, isActive: !c.isActive })
    await condQ.refetch()
  }

  const tier = (spent: number) => {
    if (spent >= 5_000_000) return { label: 'Platinum', color: 'text-purple-600 bg-purple-50' }
    if (spent >= 2_000_000) return { label: 'Gold', color: 'text-yellow-600 bg-yellow-50' }
    if (spent >= 500_000) return { label: 'Silver', color: 'text-gray-600 bg-gray-100' }
    return { label: 'Member', color: 'text-indigo-600 bg-indigo-50' }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Pelanggan</h2>
          <p className="text-sm text-gray-400">{customers.length} pelanggan terdaftar</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            <button onClick={() => setTab('customers')} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === 'customers' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>Pelanggan</button>
            <button onClick={() => setTab('settings')} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === 'settings' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
              <Settings2 className="w-3.5 h-3.5 inline mr-1" />Loyalitas
            </button>
          </div>
          {tab === 'customers' && (
            <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '' }); setErr(null); setOpen(true) }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Tambah
            </button>
          )}
          {tab === 'settings' && subTab === 'conditions' && (
            <button onClick={() => { setEditingCond(null); setCondForm({ ...EMPTY_COND }); setCondOpen(true) }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
              <Plus className="w-4 h-4" /> Tambah Kondisi
            </button>
          )}
        </div>
      </div>

      {tab === 'settings' ? (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button onClick={() => setSubTab('general')} className={`px-4 py-2 rounded-xl text-sm font-bold ${subTab === 'general' ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Pengaturan Umum</button>
            <button onClick={() => setSubTab('conditions')} className={`px-4 py-2 rounded-xl text-sm font-bold ${subTab === 'conditions' ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Kondisi Khusus</button>
          </div>

          {subTab === 'general' && (
            <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5 max-w-lg">
              <h3 className="font-black text-gray-900">Pengaturan Loyalitas</h3>
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Poin</p>
                  <p className="text-xs text-gray-400">Pelanggan mendapat poin setiap transaksi</p>
                </div>
                <button onClick={() => setLoyaltyForm((f) => ({ ...f, enabled: !f.enabled }))}>
                  {loyaltyForm.enabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
                </button>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-gray-100">
                <div>
                  <p className="font-bold text-gray-900 text-sm">Sistem Tier</p>
                  <p className="text-xs text-gray-400">Member / Silver / Gold / Platinum</p>
                </div>
                <button onClick={() => setLoyaltyForm((f) => ({ ...f, tierEnabled: !f.tierEnabled }))}>
                  {loyaltyForm.tierEnabled ? <ToggleRight className="w-7 h-7 text-indigo-600" /> : <ToggleLeft className="w-7 h-7 text-gray-400" />}
                </button>
              </div>
              {loyaltyForm.enabled && (
                <>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Poin per Rp 1.000 belanja</label>
                    <input type="number" value={loyaltyForm.pointsPerThousand} onChange={(e) => setLoyaltyForm((f) => ({ ...f, pointsPerThousand: parseFloat(e.target.value) || 1 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Poin untuk Rp 1.000 diskon</label>
                    <input type="number" value={loyaltyForm.redemptionRate} onChange={(e) => setLoyaltyForm((f) => ({ ...f, redemptionRate: parseFloat(e.target.value) || 100 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </>
              )}
              <p className="text-xs text-gray-400">Nilai aktif: {loyalty.enabled ? 'poin ON' : 'poin OFF'} · tier {loyalty.tierEnabled ? 'ON' : 'OFF'}</p>
              <button onClick={saveLoyalty} disabled={savingLoyalty} className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {savingLoyalty ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan Pengaturan'}
              </button>
            </div>
          )}

          {subTab === 'conditions' && (
            <div className="space-y-3">
              {conditions.length === 0 ? (
                <div className="bg-white rounded-2xl border border-gray-100 p-12 flex flex-col items-center gap-3 text-gray-300">
                  <Gift className="w-12 h-12" />
                  <p className="font-bold">Belum ada kondisi loyalitas</p>
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-50">
                  {conditions.map((c) => (
                    <div key={c.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex items-start gap-3">
                        <span className={`mt-0.5 px-2 py-0.5 text-xs font-black rounded-full ${c.type === 'always_on' ? 'bg-indigo-100 text-indigo-700' : 'bg-violet-100 text-violet-700'}`}>
                          {c.type === 'always_on' ? 'Always-On' : 'Campaign'}
                        </span>
                        <div>
                          <p className="font-bold text-gray-900 text-sm">{c.name}</p>
                          <p className="text-xs text-gray-400">
                            {TRIGGER_OPTIONS.find((t) => t.value === c.trigger)?.label} →{' '}
                            {c.rewardType === 'set_points' ? `+${c.rewardValue} Poin` : c.rewardType === 'multiply_points' ? `×${c.rewardValue} Poin` : 'Produk Gratis'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => toggleCond(c)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {c.isActive ? 'Aktif' : 'Nonaktif'}
                        </button>
                        <button onClick={() => openEditCond(c)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                        <button onClick={async () => { await api.deleteLoyaltyCondition(c.id); await condQ.refetch() }} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input type="text" placeholder="Cari nama / telepon / email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {cq.loading ? (
              <TableSkeleton />
            ) : filtered.length === 0 ? (
              <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
                <Users className="w-12 h-12" />
                <p className="font-bold">Tidak ada pelanggan</p>
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
                    {filtered.map((c) => {
                      const t = tier(c.totalSpent)
                      return (
                        <tr key={c.id} className="hover:bg-gray-50">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
                                <span className="text-sm font-black text-indigo-600">{c.name.charAt(0).toUpperCase()}</span>
                              </div>
                              <div>
                                <p className="font-bold text-gray-900 text-sm">{c.name}</p>
                                <p className="text-xs text-gray-400">{c.visitCount} kunjungan</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3 hidden md:table-cell">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5 text-xs text-gray-500"><Phone className="w-3 h-3" /> {c.phone}</div>
                              {c.email && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Mail className="w-3 h-3" /> {c.email}</div>}
                            </div>
                          </td>
                          <td className="px-5 py-3"><p className="font-black text-gray-900 text-sm">{BRAND.currency.format(c.totalSpent)}</p></td>
                          {loyalty.enabled && (
                            <td className="px-5 py-3 hidden sm:table-cell">
                              <div className="flex items-center gap-1 text-sm font-bold text-indigo-600"><Star className="w-3.5 h-3.5" />{c.points.toLocaleString('id-ID')}</div>
                            </td>
                          )}
                          {loyalty.tierEnabled && (
                            <td className="px-5 py-3 hidden sm:table-cell">
                              <span className={`px-2.5 py-1 text-xs font-bold rounded-lg ${t.color}`}>{t.label}</span>
                            </td>
                          )}
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => setHistCust(c)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl" title="Riwayat"><ShoppingBag className="w-4 h-4" /></button>
                              <button onClick={() => { setEditing(c); setForm({ name: c.name, phone: c.phone, email: c.email || '' }); setErr(null); setOpen(true) }} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                              <button onClick={() => setDelId(c.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
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

      {histCust && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-xl font-black text-gray-900">Riwayat {histCust.name}</h2>
                <p className="text-xs text-gray-400">Total: {BRAND.currency.format(histCust.totalSpent)} · {histCust.visitCount} kunjungan</p>
              </div>
              <button onClick={() => setHistCust(null)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {histQ.loading ? (
                <TableSkeleton />
              ) : (histQ.data ?? []).length === 0 ? (
                <div className="p-12 text-center text-gray-300"><ShoppingBag className="w-12 h-12 mx-auto mb-3" /><p>Belum ada transaksi</p></div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {(histQ.data ?? []).map((o) => (
                    <div key={o.id}>
                      <div className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer" onClick={() => setHistExpanded(histExpanded === o.id ? null : o.id)}>
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${o.status === 'refunded' ? 'bg-red-50' : 'bg-indigo-50'}`}>
                          <ShoppingBag className={`w-4 h-4 ${o.status === 'refunded' ? 'text-red-400' : 'text-indigo-600'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-gray-900 text-sm">{o.orderNumber}</p>
                          <p className="text-xs text-gray-400">{format(parseISO(o.createdAt), 'dd MMM yyyy HH:mm', { locale: idLocale })} · <span className="capitalize">{o.paymentMethod}</span></p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`px-2 py-0.5 text-xs font-bold rounded-lg ${o.status === 'refunded' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>{o.status === 'refunded' ? 'Refund' : 'Selesai'}</span>
                          <p className="font-black text-gray-900 text-sm">{BRAND.currency.format(o.total)}</p>
                          {histExpanded === o.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                        </div>
                      </div>
                      {histExpanded === o.id && (
                        <div className="px-5 pb-3 bg-gray-50 border-t border-gray-100">
                          <div className="pt-3 space-y-1">
                            {o.items.map((it, i) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className="text-gray-600">{it.productName} {it.variantSize} ×{it.quantity}</span>
                                <span className="font-bold text-gray-900">{BRAND.currency.format(it.subtotal)}</span>
                              </div>
                            ))}
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

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editing ? 'Edit Pelanggan' : 'Tambah Pelanggan'}</h2>
              <button onClick={() => setOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              {[
                { label: 'Nama *', field: 'name' as const, type: 'text' },
                { label: 'No. Telepon *', field: 'phone' as const, type: 'tel' },
                { label: 'Email', field: 'email' as const, type: 'email' },
              ].map(({ label, field, type }) => (
                <div key={field}>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{label}</label>
                  <input type={type} value={form[field]} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              ))}
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCustomer} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {condOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingCond ? 'Edit Kondisi' : 'Tambah Kondisi Loyalitas'}</h2>
              <button onClick={() => setCondOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Kondisi *</label>
                <input type="text" value={condForm.name} onChange={(e) => setCondForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['always_on', 'campaign'] as const).map((tv) => (
                    <button key={tv} type="button" onClick={() => setCondForm((f) => ({ ...f, type: tv }))} className={`p-3 rounded-xl border-2 text-left ${condForm.type === tv ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200'}`}>
                      <p className="font-black text-sm text-gray-700">{tv === 'always_on' ? 'Always-On' : 'Campaign-Based'}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Trigger</label>
                <select value={condForm.trigger} onChange={(e) => setCondForm((f) => ({ ...f, trigger: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {TRIGGER_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              {condForm.trigger === 'member_day' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Pilih Hari</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {DAYS_ID.map((d, i) => (
                      <button key={i} type="button" onClick={() => setCondForm((f) => ({ ...f, activeDays: (f.activeDays || []).includes(i) ? (f.activeDays || []).filter((x) => x !== i) : [...(f.activeDays || []), i] }))} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(condForm.activeDays || []).includes(i) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
                    ))}
                  </div>
                </div>
              )}
              {condForm.trigger === 'product_purchase' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Produk Pemicu</label>
                  <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-1">
                    {products.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                        <input type="checkbox" checked={(condForm.applicableProductIds || []).includes(p.id)} onChange={(e) => setCondForm((f) => ({ ...f, applicableProductIds: e.target.checked ? [...(f.applicableProductIds || []), p.id] : (f.applicableProductIds || []).filter((x) => x !== p.id) }))} className="accent-indigo-600" />
                        <span className="text-sm text-gray-700">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {condForm.trigger === 'spending_threshold' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Target Belanja (Rp)</label>
                  <input type="number" value={condForm.minimumSpend || ''} onChange={(e) => setCondForm((f) => ({ ...f, minimumSpend: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Reward</label>
                <select value={condForm.rewardType} onChange={(e) => setCondForm((f) => ({ ...f, rewardType: e.target.value as CondForm['rewardType'] }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  {REWARD_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              {condForm.rewardType !== 'product_reward' && (
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">{condForm.rewardType === 'set_points' ? 'Jumlah Poin' : 'Pengali (×)'}</label>
                  <input type="number" value={condForm.rewardValue} onChange={(e) => setCondForm((f) => ({ ...f, rewardValue: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}
              {condForm.type === 'campaign' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Campaign Mulai</label>
                    <input type="date" value={condForm.campaignStartDate || ''} onChange={(e) => setCondForm((f) => ({ ...f, campaignStartDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Campaign Berakhir</label>
                    <input type="date" value={condForm.campaignEndDate || ''} onChange={(e) => setCondForm((f) => ({ ...f, campaignEndDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={condForm.isActive} onChange={(e) => setCondForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Kondisi Aktif</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setCondOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCond} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {delId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Pelanggan?</h3>
            <p className="text-sm text-gray-400 mb-6">Data poin dan riwayat akan terhapus permanen.</p>
            <div className="flex gap-3">
              <button onClick={() => setDelId(null)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={() => del(delId)} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
