import { useState } from 'react'
import type { Promotion, DiscountCode, Product, PromotionInput, DiscountCodeInput } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Edit2, Trash2, Tag, Copy, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { generateCode, exportToCSV, exportToXLSX } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'
import { ImportExportBar } from '../components/ImportExportBar'
import { Button, Input, Select, Textarea, Field, fieldClass, Modal, Card, Badge, IconButton, EmptyState, PageHeader, Tabs } from '../ui'

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

  const exportPromotions = async (fmt: 'csv' | 'xlsx') => {
    const data = await api.listPromotions()
    const rows = data.map((p) => ({
      Nama: p.name,
      Tipe: p.type === 'percentage' ? 'Persentase' : p.type === 'fixed' ? 'Nominal' : 'BOGO',
      Nilai: p.value,
      'Min. Belanja': p.minPurchase ?? 0,
      Mulai: p.startDate ?? '',
      Selesai: p.endDate ?? '',
      Aktif: p.isActive ? 'Ya' : 'Tidak',
    }))
    if (fmt === 'csv') exportToCSV(rows, 'promosi')
    else exportToXLSX(rows, 'promosi')
  }

  const exportDiscountCodes = async (fmt: 'csv' | 'xlsx') => {
    const data = await api.listDiscountCodes()
    const rows = data.map((c) => ({
      Kode: c.code,
      Tipe: c.type === 'percentage' ? 'Persentase' : 'Nominal',
      Nilai: c.value,
      'Min. Belanja': c.minPurchase ?? 0,
      Kuota: c.usageLimit ?? 0,
      Terpakai: c.usageCount,
      Aktif: c.isActive ? 'Ya' : 'Tidak',
    }))
    if (fmt === 'csv') exportToCSV(rows, 'kode-diskon')
    else exportToXLSX(rows, 'kode-diskon')
  }

  const today = new Date().toISOString().slice(0, 10)
  const promoStatus = (p: Promotion) => {
    if (!p.isActive) return { label: 'Nonaktif', color: 'bg-gray-100 text-gray-600' }
    if (p.endDate && p.endDate < today) return { label: 'Kadaluarsa', color: 'bg-red-50 text-red-700' }
    if (p.startDate && p.startDate > today) return { label: 'Belum Mulai', color: 'bg-amber-50 text-amber-700' }
    return { label: 'Aktif', color: 'bg-green-50 text-green-700' }
  }

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Promosi"
        subtitle={`${promotions.length} promosi · ${codes.length} kode diskon`}
        actions={
          <>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'promotions', label: 'Promosi' },
                { id: 'codes', label: 'Kode Diskon' },
              ]}
            />
            <ImportExportBar
              onExport={(fmt) =>
                tab === 'promotions'
                  ? void exportPromotions(fmt)
                  : void exportDiscountCodes(fmt)
              }
              exportDisabled={tab === 'promotions' ? promotions.length === 0 : codes.length === 0}
            />
            <Button
              icon={<Plus className="w-4 h-4" />}
              onClick={() =>
                tab === 'promotions'
                  ? (setEditingPromo(null), setPromoForm({ ...EMPTY_PROMO }), setPromoOpen(true))
                  : (setEditingCode(null), setCodeForm({ ...EMPTY_CODE }), setCodeOpen(true))
              }
            >
              {tab === 'promotions' ? 'Tambah Promosi' : 'Tambah Kode'}
            </Button>
          </>
        }
      />

      {tab === 'promotions' && (
        <Card className="overflow-hidden">
          {promotions.length === 0 ? (
            <EmptyState icon={<Tag />} title="Belum ada promosi" />
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
                          {p.combinable && <Badge tone="gold" className="inline-block mt-0.5">Bisa Kombinasi</Badge>}
                        </td>
                        <td className="px-5 py-3"><Badge tone="gold">{p.type === 'percentage' ? 'Persentase' : p.type === 'fixed' ? 'Nominal' : 'BOGO'}</Badge></td>
                        <td className="px-5 py-3 font-bold text-gray-900 text-sm">{p.type === 'percentage' ? `${p.value}%` : p.type === 'fixed' ? BRAND.currency.format(p.value) : 'Buy 1 Get 1'}</td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {p.startDate ? format(parseISO(p.startDate), 'dd MMM', { locale: idLocale }) : '—'} → {p.endDate ? format(parseISO(p.endDate), 'dd MMM yy', { locale: idLocale }) : '∞'}
                        </td>
                        <td className="px-5 py-3"><button onClick={() => togglePromo(p)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${st.color}`}>{st.label}</button></td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-1">
                            <IconButton onClick={() => openEditPromo(p)}><Edit2 className="w-4 h-4" /></IconButton>
                            <IconButton onClick={() => dupPromo(p)} title="Duplikat"><Copy className="w-4 h-4" /></IconButton>
                            <IconButton tone="danger" onClick={() => setDelPromo(p.id)}><Trash2 className="w-4 h-4" /></IconButton>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'codes' && (
        <Card className="overflow-hidden">
          {codes.length === 0 ? (
            <EmptyState icon={<Tag />} title="Belum ada kode diskon" />
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
                          <span className="font-black text-gold-700 bg-gold-50 px-3 py-1 rounded-lg text-sm tracking-wider">{c.code}</span>
                          <IconButton onClick={() => navigator.clipboard.writeText(c.code)} className="p-1"><Copy className="w-3.5 h-3.5" /></IconButton>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-bold text-gray-900 text-sm">{c.type === 'percentage' ? `${c.value}%` : BRAND.currency.format(c.value)}</td>
                      <td className="px-5 py-3 text-sm text-gray-600">{c.minPurchase ? BRAND.currency.format(c.minPurchase) : '—'}</td>
                      <td className="px-5 py-3 text-sm font-bold text-gray-900">{c.usageCount} / {c.usageLimit || '∞'}</td>
                      <td className="px-5 py-3"><button onClick={() => toggleCode(c)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{c.isActive ? 'Aktif' : 'Nonaktif'}</button></td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1">
                          <IconButton onClick={() => openEditCode(c)}><Edit2 className="w-4 h-4" /></IconButton>
                          <IconButton tone="danger" onClick={() => setDelCode(c.id)}><Trash2 className="w-4 h-4" /></IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Modal
        open={promoOpen}
        onClose={() => setPromoOpen(false)}
        size="lg"
        title={editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setPromoOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={savePromo}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama Promosi *" type="text" value={promoForm.name} onChange={(e) => setPromoForm((f) => ({ ...f, name: e.target.value }))} />
          <Textarea label="Deskripsi" value={promoForm.description || ''} onChange={(e) => setPromoForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
          <div className="grid grid-cols-2 gap-4">
            <Select label="Tipe" value={promoForm.type} onChange={(e) => setPromoForm((f) => ({ ...f, type: e.target.value as PromotionInput['type'] }))}>
              <option value="percentage">Persentase (%)</option>
              <option value="fixed">Nominal (Rp)</option>
              <option value="bogo">Buy 1 Get 1</option>
            </Select>
            {promoForm.type !== 'bogo' && (
              <Input label="Nilai" type="number" value={promoForm.value} onChange={(e) => setPromoForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
            )}
          </div>
          <Input label="Minimum Pembelian (Rp)" type="number" value={promoForm.minPurchase || ''} onChange={(e) => setPromoForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Mulai" type="date" value={promoForm.startDate || ''} onChange={(e) => setPromoForm((f) => ({ ...f, startDate: e.target.value }))} />
            <Input label="Berakhir" type="date" value={promoForm.endDate || ''} onChange={(e) => setPromoForm((f) => ({ ...f, endDate: e.target.value }))} />
          </div>
          <Field label="Aktif Hari (kosong = semua)">
            <div className="flex gap-1.5 flex-wrap">
              {DAYS.map((d, i) => (
                <button key={i} type="button" onClick={() => toggleDay(i)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(promoForm.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
              ))}
            </div>
          </Field>
          <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
            <input type="checkbox" checked={promoForm.combinable ?? false} onChange={(e) => setPromoForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
            <span className="text-sm font-bold text-gray-900">Bisa dikombinasikan dengan promosi lain</span>
          </label>
          <Field label="Varian Spesifik (opsional)">
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
                            <input type="checkbox" checked={(promoForm.applicableVariantKeys || []).includes(key)} onChange={() => toggleVariant(p.id, v.size)} className="accent-gold-600" />
                            <span className="text-xs text-gray-600">{v.size} — {BRAND.currency.format(v.price)}</span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Field>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={promoForm.isActive} onChange={(e) => setPromoForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
            <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
          </label>
        </div>
      </Modal>

      <Modal
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        title={editingCode ? 'Edit Kode' : 'Tambah Kode Diskon'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => setCodeOpen(false)}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={saveCode}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Kode *">
            <div className="flex gap-2">
              <input type="text" value={codeForm.code} onChange={(e) => setCodeForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} className={`${fieldClass} flex-1 font-mono tracking-wider`} />
              <Button variant="secondary" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => setCodeForm((f) => ({ ...f, code: generateCode() }))} />
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Tipe" value={codeForm.type} onChange={(e) => setCodeForm((f) => ({ ...f, type: e.target.value as DiscountCodeInput['type'] }))}>
              <option value="percentage">Persentase (%)</option>
              <option value="fixed">Nominal (Rp)</option>
            </Select>
            <Input label="Nilai" type="number" value={codeForm.value} onChange={(e) => setCodeForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Min. Beli" type="number" value={codeForm.minPurchase || ''} onChange={(e) => setCodeForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
            <Input label="Batas Pakai" type="number" value={codeForm.usageLimit || ''} onChange={(e) => setCodeForm((f) => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Mulai" type="date" value={codeForm.startDate || ''} onChange={(e) => setCodeForm((f) => ({ ...f, startDate: e.target.value }))} />
            <Input label="Berakhir" type="date" value={codeForm.endDate || ''} onChange={(e) => setCodeForm((f) => ({ ...f, endDate: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={codeForm.isActive} onChange={(e) => setCodeForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
            <span className="text-sm font-bold text-gray-700">Kode Aktif</span>
          </label>
        </div>
      </Modal>

      <Modal
        open={!!(delPromo || delCode)}
        onClose={() => { setDelPromo(null); setDelCode(null) }}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={() => { setDelPromo(null); setDelCode(null) }}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={async () => { if (delPromo) { await api.deletePromotion(delPromo); setDelPromo(null); await prq.refetch() } if (delCode) { await api.deleteDiscountCode(delCode); setDelCode(null); await dcq.refetch() } }}>Ya, Hapus</Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Konfirmasi Hapus</h3>
          <p className="text-sm text-gray-400">Data tidak dapat dikembalikan.</p>
        </div>
      </Modal>
    </div>
  )
}
