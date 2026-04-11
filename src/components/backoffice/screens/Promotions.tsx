import { useState, useEffect } from 'react'
import type { AppUser, Promotion, DiscountCode, Product } from '../../../types'
import { db } from '../../../firebase'
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore'
import { BRAND } from '../../../config/brand'
import { generateCode } from '../../../lib/csvUtils'
import { Plus, Edit2, Trash2, X, Tag, Copy, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'

interface Props { appUser?: AppUser }

const DAYS_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

const EMPTY_PROMO: Omit<Promotion, 'id' | 'createdAt'> = {
  name: '', description: '', type: 'percentage', value: 0,
  minPurchase: 0, applicableProductIds: [], applicableVariantKeys: [],
  isActive: true, combinable: false, activeFromHour: '', activeToHour: '', activeDays: [],
}

const EMPTY_CODE: Omit<DiscountCode, 'id' | 'createdAt'> = {
  code: '', type: 'percentage', value: 0, minPurchase: 0,
  usageLimit: 0, usageCount: 0, isActive: true,
}

export default function Promotions({ appUser: _appUser }: Props) {
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [codes, setCodes] = useState<DiscountCode[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [activeTab, setActiveTab] = useState<'promotions' | 'codes'>('promotions')

  const [isPromoModalOpen, setIsPromoModalOpen] = useState(false)
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null)
  const [promoForm, setPromoForm] = useState<Omit<Promotion, 'id' | 'createdAt'>>(EMPTY_PROMO)
  const [showVariantPicker, setShowVariantPicker] = useState<string | null>(null)

  const [isCodeModalOpen, setIsCodeModalOpen] = useState(false)
  const [editingCode, setEditingCode] = useState<DiscountCode | null>(null)
  const [codeForm, setCodeForm] = useState(EMPTY_CODE)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [deletePromoId, setDeletePromoId] = useState<string | null>(null)
  const [deleteCodeId, setDeleteCodeId] = useState<string | null>(null)

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'promotions'), s => setPromotions(s.docs.map(d => ({ id: d.id, ...d.data() } as Promotion))))
    const u2 = onSnapshot(collection(db, 'discountCodes'), s => setCodes(s.docs.map(d => ({ id: d.id, ...d.data() } as DiscountCode))))
    const u3 = onSnapshot(collection(db, 'products'), s => setProducts(s.docs.map(d => ({ id: d.id, ...d.data() } as Product)).filter(p => p.isActive)))
    return () => { u1(); u2(); u3() }
  }, [])

  // Promotions CRUD
  const openAddPromo = () => { setEditingPromo(null); setPromoForm({ ...EMPTY_PROMO }); setIsPromoModalOpen(true) }
  const openEditPromo = (p: Promotion) => {
    setEditingPromo(p)
    setPromoForm({
      name: p.name, description: p.description || '', type: p.type, value: p.value,
      minPurchase: p.minPurchase || 0, applicableProductIds: p.applicableProductIds || [],
      applicableVariantKeys: p.applicableVariantKeys || [],
      isActive: p.isActive, startDate: p.startDate, endDate: p.endDate,
      combinable: p.combinable ?? false, combinableWith: p.combinableWith,
      activeFromHour: p.activeFromHour || '', activeToHour: p.activeToHour || '',
      activeDays: p.activeDays || [],
    })
    setIsPromoModalOpen(true)
  }

  const duplicatePromo = async (p: Promotion) => {
    const data: Omit<Promotion, 'id'> = {
      ...p, name: `${p.name} (Salinan)`, createdAt: new Date().toISOString(),
    }
    delete (data as any).id
    await addDoc(collection(db, 'promotions'), data)
  }

  const savePromo = async () => {
    if (!promoForm.name.trim()) { alert('Nama promosi wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = { ...promoForm, createdAt: editingPromo?.createdAt || new Date().toISOString() }
      if (editingPromo?.id) await updateDoc(doc(db, 'promotions', editingPromo.id), data)
      else await addDoc(collection(db, 'promotions'), data)
      setIsPromoModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  const togglePromoActive = async (p: Promotion) => {
    if (!p.id) return
    await updateDoc(doc(db, 'promotions', p.id), { isActive: !p.isActive })
  }

  // Discount Codes CRUD
  const openAddCode = () => { setEditingCode(null); setCodeForm({ ...EMPTY_CODE }); setIsCodeModalOpen(true) }
  const openEditCode = (c: DiscountCode) => {
    setEditingCode(c)
    setCodeForm({ code: c.code, type: c.type, value: c.value, minPurchase: c.minPurchase || 0, usageLimit: c.usageLimit || 0, usageCount: c.usageCount, isActive: c.isActive, startDate: c.startDate, endDate: c.endDate })
    setIsCodeModalOpen(true)
  }

  const saveCode = async () => {
    if (!codeForm.code.trim()) { alert('Kode wajib diisi'); return }
    setIsSubmitting(true)
    try {
      const data = { ...codeForm, code: codeForm.code.toUpperCase(), createdAt: editingCode?.createdAt || new Date().toISOString() }
      if (editingCode?.id) await updateDoc(doc(db, 'discountCodes', editingCode.id), data)
      else await addDoc(collection(db, 'discountCodes'), data)
      setIsCodeModalOpen(false)
    } catch { alert('Gagal menyimpan.') }
    finally { setIsSubmitting(false) }
  }

  const resetUsage = async (c: DiscountCode) => {
    if (!c.id) return
    if (!confirm(`Reset usage count untuk kode ${c.code}?`)) return
    await updateDoc(doc(db, 'discountCodes', c.id), { usageCount: 0 })
  }

  const toggleCodeActive = async (c: DiscountCode) => {
    if (!c.id) return
    await updateDoc(doc(db, 'discountCodes', c.id), { isActive: !c.isActive })
  }

  const copyCode = (code: string) => { navigator.clipboard.writeText(code); alert(`Kode "${code}" disalin!`) }

  const isExpired = (endDate?: string) => endDate && endDate < new Date().toISOString().slice(0, 10)
  const isNotStarted = (startDate?: string) => startDate && startDate > new Date().toISOString().slice(0, 10)

  const getPromoStatus = (p: Promotion) => {
    if (!p.isActive) return { label: 'Nonaktif', color: 'bg-gray-100 text-gray-500' }
    if (isExpired(p.endDate)) return { label: 'Kadaluarsa', color: 'bg-red-50 text-red-600' }
    if (isNotStarted(p.startDate)) return { label: 'Belum Mulai', color: 'bg-yellow-50 text-yellow-600' }
    return { label: 'Aktif', color: 'bg-green-50 text-green-700' }
  }

  // Variant key helpers: "productId::variantSize"
  const toggleVariantKey = (productId: string, size: string) => {
    const key = `${productId}::${size}`
    setPromoForm(f => ({
      ...f,
      applicableVariantKeys: (f.applicableVariantKeys || []).includes(key)
        ? (f.applicableVariantKeys || []).filter(k => k !== key)
        : [...(f.applicableVariantKeys || []), key],
    }))
  }

  const toggleDay = (day: number) => {
    setPromoForm(f => ({
      ...f,
      activeDays: (f.activeDays || []).includes(day)
        ? (f.activeDays || []).filter(d => d !== day)
        : [...(f.activeDays || []), day],
    }))
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-black text-gray-900">Promosi</h2>
          <p className="text-sm text-gray-400">{promotions.length} promosi · {codes.length} kode diskon</p>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-100 rounded-xl p-1">
            {(['promotions', 'codes'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {tab === 'promotions' ? 'Promosi' : 'Kode Diskon'}
              </button>
            ))}
          </div>
          <button onClick={activeTab === 'promotions' ? openAddPromo : openAddCode}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-indigo-100">
            <Plus className="w-4 h-4" />
            {activeTab === 'promotions' ? 'Tambah Promosi' : 'Tambah Kode'}
          </button>
        </div>
      </div>

      {/* PROMOTIONS LIST */}
      {activeTab === 'promotions' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {promotions.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
              <Tag className="w-12 h-12" /><p className="font-bold">Belum ada promosi</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Promosi', 'Tipe', 'Nilai', 'Kondisi', 'Periode', 'Status', 'Aksi'].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {promotions.map(p => {
                    const status = getPromoStatus(p)
                    return (
                      <tr key={p.id} className="hover:bg-gray-50 transition-all">
                        <td className="px-5 py-3">
                          <p className="font-bold text-gray-900 text-sm">{p.name}</p>
                          {p.description && <p className="text-xs text-gray-400">{p.description}</p>}
                          {(p.applicableVariantKeys || []).length > 0
                            ? <p className="text-xs text-indigo-600 mt-0.5">{p.applicableVariantKeys!.length} varian spesifik</p>
                            : (p.applicableProductIds || []).length > 0
                            ? <p className="text-xs text-indigo-600 mt-0.5">{p.applicableProductIds!.length} produk spesifik</p>
                            : null}
                          {p.combinable && <span className="inline-block mt-0.5 px-1.5 py-0.5 bg-violet-50 text-violet-600 text-xs font-bold rounded">Bisa Kombinasi</span>}
                        </td>
                        <td className="px-5 py-3">
                          <span className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-lg">
                            {p.type === 'percentage' ? 'Persentase' : p.type === 'fixed' ? 'Nominal' : 'BOGO'}
                          </span>
                        </td>
                        <td className="px-5 py-3 font-bold text-gray-900 text-sm">
                          {p.type === 'percentage' ? `${p.value}%` : p.type === 'fixed' ? BRAND.currency.format(p.value) : 'Buy 1 Get 1'}
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {p.activeFromHour && p.activeToHour ? <p>{p.activeFromHour}–{p.activeToHour}</p> : null}
                          {(p.activeDays || []).length > 0 ? <p>{(p.activeDays || []).map(d => DAYS_ID[d]).join(', ')}</p> : null}
                          {!p.activeFromHour && !(p.activeDays || []).length ? '—' : null}
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {p.startDate ? format(parseISO(p.startDate), 'dd MMM', { locale: idLocale }) : '—'}
                          {' → '}
                          {p.endDate ? format(parseISO(p.endDate), 'dd MMM yy', { locale: idLocale }) : '∞'}
                        </td>
                        <td className="px-5 py-3">
                          <button onClick={() => togglePromoActive(p)} className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all ${status.color}`}>
                            {status.label}
                          </button>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEditPromo(p)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl transition-all"><Edit2 className="w-4 h-4" /></button>
                            <button onClick={() => duplicatePromo(p)} title="Duplikat" className="p-2 hover:bg-violet-50 hover:text-violet-600 text-gray-400 rounded-xl transition-all"><Copy className="w-4 h-4" /></button>
                            <button onClick={() => setDeletePromoId(p.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl transition-all"><Trash2 className="w-4 h-4" /></button>
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
      )}

      {/* DISCOUNT CODES LIST */}
      {activeTab === 'codes' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {codes.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300">
              <Tag className="w-12 h-12" /><p className="font-bold">Belum ada kode diskon</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Kode', 'Diskon', 'Min. Pembelian', 'Penggunaan', 'Periode', 'Status', 'Aksi'].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {codes.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50 transition-all">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-indigo-700 bg-indigo-50 px-3 py-1 rounded-lg text-sm tracking-wider">{c.code}</span>
                          <button onClick={() => copyCode(c.code)} className="p-1 text-gray-400 hover:text-indigo-600"><Copy className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-bold text-gray-900 text-sm">{c.type === 'percentage' ? `${c.value}%` : BRAND.currency.format(c.value)}</td>
                      <td className="px-5 py-3 text-sm text-gray-600">{c.minPurchase ? BRAND.currency.format(c.minPurchase) : '—'}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div>
                            <p className="text-sm font-bold text-gray-900">{c.usageCount} / {c.usageLimit || '∞'}</p>
                            {c.usageLimit ? <div className="w-20 h-1.5 bg-gray-100 rounded-full mt-1"><div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, (c.usageCount / c.usageLimit) * 100)}%` }} /></div> : null}
                          </div>
                          <button onClick={() => resetUsage(c)} className="p-1.5 text-gray-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"><RefreshCw className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-500">
                        {c.startDate ? format(parseISO(c.startDate), 'dd MMM', { locale: idLocale }) : '—'} → {c.endDate ? format(parseISO(c.endDate), 'dd MMM yy', { locale: idLocale }) : '∞'}
                      </td>
                      <td className="px-5 py-3">
                        <button onClick={() => toggleCodeActive(c)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {c.isActive ? 'Aktif' : 'Nonaktif'}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEditCode(c)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                          <button onClick={() => setDeleteCodeId(c.id!)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* PROMO MODAL */}
      {isPromoModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}</h2>
              <button onClick={() => setIsPromoModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">

              {/* Name & Desc */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Promosi *</label>
                <input type="text" value={promoForm.name} onChange={e => setPromoForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Contoh: Diskon Akhir Tahun"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={promoForm.description || ''} onChange={e => setPromoForm(f => ({ ...f, description: e.target.value }))}
                  rows={2} placeholder="Syarat & ketentuan promosi..."
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>

              {/* Type + Value */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe Diskon</label>
                  <select value={promoForm.type} onChange={e => setPromoForm(f => ({ ...f, type: e.target.value as any }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="percentage">Persentase (%)</option>
                    <option value="fixed">Nominal (Rp)</option>
                    <option value="bogo">Buy 1 Get 1</option>
                  </select>
                </div>
                {promoForm.type !== 'bogo' && (
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nilai {promoForm.type === 'percentage' ? '(%)' : '(Rp)'}</label>
                    <input type="number" value={promoForm.value} onChange={e => setPromoForm(f => ({ ...f, value: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                )}
              </div>

              {/* Min purchase */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Minimum Pembelian (Rp)</label>
                <input type="number" value={promoForm.minPurchase || ''} onChange={e => setPromoForm(f => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))}
                  placeholder="0 = tidak ada minimum"
                  className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>

              {/* Date range */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Mulai</label>
                  <input type="date" value={promoForm.startDate || ''} onChange={e => setPromoForm(f => ({ ...f, startDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Berakhir</label>
                  <input type="date" value={promoForm.endDate || ''} onChange={e => setPromoForm(f => ({ ...f, endDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>

              {/* Active hours */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Aktif Jam (opsional)</label>
                <div className="grid grid-cols-2 gap-3">
                  <input type="time" value={promoForm.activeFromHour || ''} onChange={e => setPromoForm(f => ({ ...f, activeFromHour: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Dari" />
                  <input type="time" value={promoForm.activeToHour || ''} onChange={e => setPromoForm(f => ({ ...f, activeToHour: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Sampai" />
                </div>
              </div>

              {/* Active days */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Aktif Hari (opsional, kosong = semua hari)</label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAYS_ID.map((day, i) => (
                    <button key={i} type="button" onClick={() => toggleDay(i)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border-2 ${(promoForm.activeDays || []).includes(i) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600'}`}>
                      {day}
                    </button>
                  ))}
                </div>
              </div>

              {/* Combinable */}
              <div className="flex items-start gap-3 p-3 bg-violet-50 rounded-xl">
                <input type="checkbox" id="combinable" checked={promoForm.combinable ?? false}
                  onChange={e => setPromoForm(f => ({ ...f, combinable: e.target.checked }))}
                  className="w-4 h-4 accent-indigo-600 mt-0.5" />
                <div>
                  <label htmlFor="combinable" className="text-sm font-bold text-gray-900 cursor-pointer">Bisa dikombinasikan dengan promosi lain</label>
                  <p className="text-xs text-gray-500">Centang jika promosi ini bisa digunakan bersamaan dengan promosi lain</p>
                </div>
              </div>

              {/* Variant/Product picker */}
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Produk & Varian Spesifik (opsional)</label>
                <p className="text-xs text-gray-400 mb-2">Kosongkan untuk berlaku ke semua produk. Pilih varian untuk kondisi lebih spesifik.</p>
                <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-200 rounded-xl p-2">
                  {products.map(p => (
                    <div key={p.id}>
                      <button type="button" onClick={() => setShowVariantPicker(showVariantPicker === p.id ? null : p.id!)}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-gray-50 rounded-lg text-left">
                        <span className="text-sm font-bold text-gray-700">{p.name}</span>
                        {showVariantPicker === p.id ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                      </button>
                      {showVariantPicker === p.id && (
                        <div className="ml-4 space-y-0.5 mt-0.5">
                          {p.variants.map(v => {
                            const key = `${p.id}::${v.size}`
                            const checked = (promoForm.applicableVariantKeys || []).includes(key)
                            return (
                              <label key={v.size} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                                <input type="checkbox" checked={checked} onChange={() => toggleVariantKey(p.id!, v.size)} className="accent-indigo-600" />
                                <span className="text-xs text-gray-600">{v.size} — {BRAND.currency.format(v.price)}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {(promoForm.applicableVariantKeys || []).length > 0 && (
                  <p className="text-xs text-indigo-600 mt-1 font-bold">{(promoForm.applicableVariantKeys || []).length} varian dipilih</p>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={promoForm.isActive} onChange={e => setPromoForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setIsPromoModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={savePromo} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CODE MODAL */}
      {isCodeModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingCode ? 'Edit Kode' : 'Tambah Kode Diskon'}</h2>
              <button onClick={() => setIsCodeModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Kode *</label>
                <div className="flex gap-2">
                  <input type="text" value={codeForm.code}
                    onChange={e => setCodeForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                    placeholder="Contoh: PROMO20"
                    className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono tracking-wider" />
                  <button onClick={() => setCodeForm(f => ({ ...f, code: generateCode() }))}
                    className="px-3 py-2 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 text-gray-600 text-xs font-bold rounded-xl transition-all">Auto</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe</label>
                  <select value={codeForm.type} onChange={e => setCodeForm(f => ({ ...f, type: e.target.value as any }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none">
                    <option value="percentage">Persentase (%)</option>
                    <option value="fixed">Nominal (Rp)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nilai</label>
                  <input type="number" value={codeForm.value} onChange={e => setCodeForm(f => ({ ...f, value: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Min. Pembelian</label>
                  <input type="number" value={codeForm.minPurchase || ''} onChange={e => setCodeForm(f => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))}
                    placeholder="0 = tidak ada" className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Batas Penggunaan</label>
                  <input type="number" value={codeForm.usageLimit || ''} onChange={e => setCodeForm(f => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))}
                    placeholder="0 = unlimited" className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Mulai</label>
                  <input type="date" value={codeForm.startDate || ''} onChange={e => setCodeForm(f => ({ ...f, startDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tanggal Berakhir</label>
                  <input type="date" value={codeForm.endDate || ''} onChange={e => setCodeForm(f => ({ ...f, endDate: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={codeForm.isActive} onChange={e => setCodeForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Kode Aktif</span>
              </label>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setIsCodeModalOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCode} disabled={isSubmitting} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirms */}
      {(deletePromoId || deleteCodeId) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
            <p className="text-sm text-gray-400 mb-6">Data tidak dapat dikembalikan.</p>
            <div className="flex gap-3">
              <button onClick={() => { setDeletePromoId(null); setDeleteCodeId(null) }} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => {
                if (deletePromoId) { await deleteDoc(doc(db, 'promotions', deletePromoId)); setDeletePromoId(null) }
                if (deleteCodeId) { await deleteDoc(doc(db, 'discountCodes', deleteCodeId)); setDeleteCodeId(null) }
              }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
