import { useState } from 'react'
import type { Promotion, DiscountCode, Product, PromotionInput, DiscountCodeInput } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Edit2, Trash2, X, Tag, Copy, Loader2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { generateCode } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']
const EMPTY_PROMO: PromotionInput = {
  name: '', description: '', type: 'percentage', value: 0, minPurchase: 0,
  applicableProductIds: [], applicableVariantKeys: [], isActive: true,
  combinable: false, activeFromHour: '', activeToHour: '', activeDays: [],
}
const EMPTY_CODE: DiscountCodeInput = {
  code: '', type: 'percentage', value: 0, minPurchase: 0, usageLimit: 0, isActive: true,
}

export default function Promotions() {
  const prq = usePolledQuery<Promotion[]>(() => api.listPromotions(), [])
  const dcq = usePolledQuery<DiscountCode[]>(() => api.listDiscountCodes(), [])
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data.filter((p) => p.isActive)), [])
  const promotions = prq.data ?? []
  const codes = dcq.data ?? []
  const products = pq.data ?? []

  const [tab, setTab] = useState<'promotions' | 'codes'>('promotions')
  const [promoOpen, setPromoOpen] = useState(false)
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null)
  const [promoForm, setPromoForm] = useState<PromotionInput>(EMPTY_PROMO)
  const [variantPicker, setVariantPicker] = useState<string | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)
  const [editingCode, setEditingCode] = useState<DiscountCode | null>(null)
  const [codeForm, setCodeForm] = useState<DiscountCodeInput>(EMPTY_CODE)
  const [busy, setBusy] = useState(false)
  const [delPromo, setDelPromo] = useState<string | null>(null)
  const [delCode, setDelCode] = useState<string | null>(null)

  const openEditPromo = (p: Promotion) => {
    setEditingPromo(p)
    setPromoForm({
      name: p.name, description: p.description || '', type: p.type, value: p.value,
      minPurchase: p.minPurchase || 0, applicableProductIds: p.applicableProductIds || [],
      applicableVariantKeys: p.applicableVariantKeys || [], isActive: p.isActive,
      startDate: p.startDate || undefined, endDate: p.endDate || undefined,
      combinable: p.combinable ?? false, activeFromHour: p.activeFromHour || '',
      activeToHour: p.activeToHour || '', activeDays: p.activeDays || [],
    })
    setPromoOpen(true)
  }
  const savePromo = async () => {
    if (!promoForm.name.trim()) return
    setBusy(true)
    try {
      if (editingPromo) await api.updatePromotion(editingPromo.id, promoForm)
      else await api.createPromotion(promoForm)
      setPromoOpen(false)
      await prq.refetch()
    } finally {
      setBusy(false)
    }
  }
  const dupPromo = async (p: Promotion) => {
    await api.createPromotion({
      name: `${p.name} (Salinan)`, description: p.description || '', type: p.type,
      value: p.value, minPurchase: p.minPurchase || 0,
      applicableProductIds: p.applicableProductIds || [],
      applicableVariantKeys: p.applicableVariantKeys || [], isActive: p.isActive,
      combinable: p.combinable ?? false, activeFromHour: p.activeFromHour || '',
      activeToHour: p.activeToHour || '', activeDays: p.activeDays || [],
      startDate: p.startDate || undefined, endDate: p.endDate || undefined,
    })
    await prq.refetch()
  }
  const togglePromo = async (p: Promotion) => {
    await api.updatePromotion(p.id, {
      name: p.name, description: p.description || '', type: p.type, value: p.value,
      minPurchase: p.minPurchase || 0, applicableProductIds: p.applicableProductIds || [],
      applicableVariantKeys: p.applicableVariantKeys || [], isActive: !p.isActive,
      combinable: p.combinable ?? false, activeFromHour: p.activeFromHour || '',
      activeToHour: p.activeToHour || '', activeDays: p.activeDays || [],
      startDate: p.startDate || undefined, endDate: p.endDate || undefined,
    })
    await prq.refetch()
  }

  const openEditCode = (c: DiscountCode) => {
    setEditingCode(c)
    setCodeForm({
      code: c.code, type: c.type, value: c.value, minPurchase: c.minPurchase || 0,
      usageLimit: c.usageLimit || 0, isActive: c.isActive,
      startDate: c.startDate || undefined, endDate: c.endDate || undefined,
    })
    setCodeOpen(true)
  }
  const saveCode = async () => {
    if (!codeForm.code.trim()) return
    setBusy(true)
    try {
      const body = { ...codeForm, code: codeForm.code.toUpperCase() }
      if (editingCode) await api.updateDiscountCode(editingCode.id, body)
      else await api.createDiscountCode(body)
      setCodeOpen(false)
      await dcq.refetch()
    } finally {
      setBusy(false)
    }
  }
  const toggleCode = async (c: DiscountCode) => {
    await api.updateDiscountCode(c.id, {
      code: c.code, type: c.type, value: c.value, minPurchase: c.minPurchase || 0,
      usageLimit: c.usageLimit || 0, isActive: !c.isActive,
      startDate: c.startDate || undefined, endDate: c.endDate || undefined,
    })
    await dcq.refetch()
  }

  const toggleVariant = (pid: string, size: string) => {
    const key = `${pid}::${size}`
    setPromoForm((f) => ({
      ...f,
      applicableVariantKeys: (f.applicableVariantKeys || []).includes(key)
        ? (f.applicableVariantKeys || []).filter((k) => k !== key)
        : [...(f.applicableVariantKeys || []), key],
    }))
  }
  const toggleDay = (d: number) =>
    setPromoForm((f) => ({
      ...f,
      activeDays: (f.activeDays || []).includes(d)
        ? (f.activeDays || []).filter((x) => x !== d)
        : [...(f.activeDays || []), d],
    }))

  const today = new Date().toISOString().slice(0, 10)
  const promoStatus = (p: Promotion) => {
    if (!p.isActive) return { label: 'Nonaktif', color: 'bg-gray-100 text-gray-500' }
    if (p.endDate && p.endDate < today) return { label: 'Kadaluarsa', color: 'bg-red-50 text-red-600' }
    if (p.startDate && p.startDate > today) return { label: 'Belum Mulai', color: 'bg-yellow-50 text-yellow-600' }
    return { label: 'Aktif', color: 'bg-green-50 text-green-700' }
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
            {(['promotions', 'codes'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                {t === 'promotions' ? 'Promosi' : 'Kode Diskon'}
              </button>
            ))}
          </div>
          <button onClick={() => (tab === 'promotions' ? (setEditingPromo(null), setPromoForm({ ...EMPTY_PROMO }), setPromoOpen(true)) : (setEditingCode(null), setCodeForm({ ...EMPTY_CODE }), setCodeOpen(true)))} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-sm shadow-lg shadow-indigo-100">
            <Plus className="w-4 h-4" /> {tab === 'promotions' ? 'Tambah Promosi' : 'Tambah Kode'}
          </button>
        </div>
      </div>

      {tab === 'promotions' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {promotions.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><Tag className="w-12 h-12" /><p className="font-bold">Belum ada promosi</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Promosi', 'Tipe', 'Nilai', 'Periode', 'Status', 'Aksi'].map((h) => <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {promotions.map((p) => {
                    const st = promoStatus(p)
                    return (
                      <tr key={p.id} className="hover:bg-gray-50">
                        <td className="px-5 py-3">
                          <p className="font-bold text-gray-900 text-sm">{p.name}</p>
                          {p.description && <p className="text-xs text-gray-400">{p.description}</p>}
                          {p.combinable && <span className="inline-block mt-0.5 px-1.5 py-0.5 bg-violet-50 text-violet-600 text-xs font-bold rounded">Bisa Kombinasi</span>}
                        </td>
                        <td className="px-5 py-3"><span className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-lg">{p.type === 'percentage' ? 'Persentase' : p.type === 'fixed' ? 'Nominal' : 'BOGO'}</span></td>
                        <td className="px-5 py-3 font-bold text-gray-900 text-sm">{p.type === 'percentage' ? `${p.value}%` : p.type === 'fixed' ? BRAND.currency.format(p.value) : 'Buy 1 Get 1'}</td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {p.startDate ? format(parseISO(p.startDate), 'dd MMM', { locale: idLocale }) : '—'} → {p.endDate ? format(parseISO(p.endDate), 'dd MMM yy', { locale: idLocale }) : '∞'}
                        </td>
                        <td className="px-5 py-3"><button onClick={() => togglePromo(p)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${st.color}`}>{st.label}</button></td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEditPromo(p)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                            <button onClick={() => dupPromo(p)} title="Duplikat" className="p-2 hover:bg-violet-50 hover:text-violet-600 text-gray-400 rounded-xl"><Copy className="w-4 h-4" /></button>
                            <button onClick={() => setDelPromo(p.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
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

      {tab === 'codes' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {codes.length === 0 ? (
            <div className="p-12 flex flex-col items-center gap-3 text-gray-300"><Tag className="w-12 h-12" /><p className="font-bold">Belum ada kode diskon</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    {['Kode', 'Diskon', 'Min. Beli', 'Penggunaan', 'Status', 'Aksi'].map((h) => <th key={h} className="text-left px-5 py-3 text-xs font-black text-gray-400 uppercase tracking-wider">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {codes.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-indigo-700 bg-indigo-50 px-3 py-1 rounded-lg text-sm tracking-wider">{c.code}</span>
                          <button onClick={() => navigator.clipboard.writeText(c.code)} className="p-1 text-gray-400 hover:text-indigo-600"><Copy className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-bold text-gray-900 text-sm">{c.type === 'percentage' ? `${c.value}%` : BRAND.currency.format(c.value)}</td>
                      <td className="px-5 py-3 text-sm text-gray-600">{c.minPurchase ? BRAND.currency.format(c.minPurchase) : '—'}</td>
                      <td className="px-5 py-3 text-sm font-bold text-gray-900">{c.usageCount} / {c.usageLimit || '∞'}</td>
                      <td className="px-5 py-3"><button onClick={() => toggleCode(c)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{c.isActive ? 'Aktif' : 'Nonaktif'}</button></td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEditCode(c)} className="p-2 hover:bg-indigo-50 hover:text-indigo-600 text-gray-400 rounded-xl"><Edit2 className="w-4 h-4" /></button>
                          <button onClick={() => setDelCode(c.id)} className="p-2 hover:bg-red-50 hover:text-red-600 text-gray-400 rounded-xl"><Trash2 className="w-4 h-4" /></button>
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

      {promoOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
              <h2 className="text-xl font-black text-gray-900">{editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}</h2>
              <button onClick={() => setPromoOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nama Promosi *</label>
                <input type="text" value={promoForm.name} onChange={(e) => setPromoForm((f) => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Deskripsi</label>
                <textarea value={promoForm.description || ''} onChange={(e) => setPromoForm((f) => ({ ...f, description: e.target.value }))} rows={2} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe</label>
                  <select value={promoForm.type} onChange={(e) => setPromoForm((f) => ({ ...f, type: e.target.value as PromotionInput['type'] }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="percentage">Persentase (%)</option>
                    <option value="fixed">Nominal (Rp)</option>
                    <option value="bogo">Buy 1 Get 1</option>
                  </select>
                </div>
                {promoForm.type !== 'bogo' && (
                  <div>
                    <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nilai</label>
                    <input type="number" value={promoForm.value} onChange={(e) => setPromoForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Minimum Pembelian (Rp)</label>
                <input type="number" value={promoForm.minPurchase || ''} onChange={(e) => setPromoForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Mulai</label>
                  <input type="date" value={promoForm.startDate || ''} onChange={(e) => setPromoForm((f) => ({ ...f, startDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Berakhir</label>
                  <input type="date" value={promoForm.endDate || ''} onChange={(e) => setPromoForm((f) => ({ ...f, endDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Aktif Hari (kosong = semua)</label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAYS.map((d, i) => (
                    <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(promoForm.activeDays || []).includes(i) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
                  ))}
                </div>
              </div>
              <label className="flex items-start gap-3 p-3 bg-violet-50 rounded-xl cursor-pointer">
                <input type="checkbox" checked={promoForm.combinable ?? false} onChange={(e) => setPromoForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-indigo-600 mt-0.5" />
                <span className="text-sm font-bold text-gray-900">Bisa dikombinasikan dengan promosi lain</span>
              </label>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Varian Spesifik (opsional)</label>
                <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-200 rounded-xl p-2">
                  {products.map((p) => (
                    <div key={p.id}>
                      <button type="button" onClick={() => setVariantPicker(variantPicker === p.id ? null : p.id)} className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-gray-50 rounded-lg text-left">
                        <span className="text-sm font-bold text-gray-700">{p.name}</span>
                        {variantPicker === p.id ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                      </button>
                      {variantPicker === p.id && (
                        <div className="ml-4 space-y-0.5 mt-0.5">
                          {p.variants.map((v) => {
                            const key = `${p.id}::${v.size}`
                            return (
                              <label key={v.size} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1">
                                <input type="checkbox" checked={(promoForm.applicableVariantKeys || []).includes(key)} onChange={() => toggleVariant(p.id, v.size)} className="accent-indigo-600" />
                                <span className="text-xs text-gray-600">{v.size} — {BRAND.currency.format(v.price)}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={promoForm.isActive} onChange={(e) => setPromoForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
              </label>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 flex-shrink-0">
              <button onClick={() => setPromoOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={savePromo} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Menyimpan...</> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {codeOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-xl font-black text-gray-900">{editingCode ? 'Edit Kode' : 'Tambah Kode Diskon'}</h2>
              <button onClick={() => setCodeOpen(false)} className="p-2 hover:bg-gray-100 rounded-xl"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Kode *</label>
                <div className="flex gap-2">
                  <input type="text" value={codeForm.code} onChange={(e) => setCodeForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} className="flex-1 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono tracking-wider" />
                  <button onClick={() => setCodeForm((f) => ({ ...f, code: generateCode() }))} className="px-3 py-2 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-600 text-gray-600 text-xs font-bold rounded-xl"><RefreshCw className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Tipe</label>
                  <select value={codeForm.type} onChange={(e) => setCodeForm((f) => ({ ...f, type: e.target.value as DiscountCodeInput['type'] }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none">
                    <option value="percentage">Persentase (%)</option>
                    <option value="fixed">Nominal (Rp)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Nilai</label>
                  <input type="number" value={codeForm.value} onChange={(e) => setCodeForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Min. Beli</label>
                  <input type="number" value={codeForm.minPurchase || ''} onChange={(e) => setCodeForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Batas Pakai</label>
                  <input type="number" value={codeForm.usageLimit || ''} onChange={(e) => setCodeForm((f) => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Mulai</label>
                  <input type="date" value={codeForm.startDate || ''} onChange={(e) => setCodeForm((f) => ({ ...f, startDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-widest mb-2">Berakhir</label>
                  <input type="date" value={codeForm.endDate || ''} onChange={(e) => setCodeForm((f) => ({ ...f, endDate: e.target.value }))} className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={codeForm.isActive} onChange={(e) => setCodeForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-indigo-600" />
                <span className="text-sm font-bold text-gray-700">Kode Aktif</span>
              </label>
            </div>
            <div className="px-6 pb-6 flex gap-3">
              <button onClick={() => setCodeOpen(false)} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={saveCode} disabled={busy} className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold rounded-2xl flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {(delPromo || delCode) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-6 w-full max-w-sm text-center">
            <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
            <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
            <p className="text-sm text-gray-400 mb-6">Data tidak dapat dikembalikan.</p>
            <div className="flex gap-3">
              <button onClick={() => { setDelPromo(null); setDelCode(null) }} className="flex-1 py-3 border-2 border-gray-200 text-gray-600 font-bold rounded-2xl">Batal</button>
              <button onClick={async () => { if (delPromo) { await api.deletePromotion(delPromo); setDelPromo(null); await prq.refetch() } if (delCode) { await api.deleteDiscountCode(delCode); setDelCode(null); await dcq.refetch() } }} className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl">Ya, Hapus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
