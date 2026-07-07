import { useState } from 'react'
import type { Promotion, DiscountCode, Product, PromotionInput, DiscountCodeInput, DiscountCodeBatchInput, Outlet } from '@mandalika/api'
import { format, parseISO } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Plus, Edit2, Trash2, Tag, Copy, Layers } from 'lucide-react'
import { api } from '../api'
import { usePolledQuery } from '../hooks/usePolledQuery'
import { exportToCSV, exportToXLSX } from '../lib/csvUtils'
import { BRAND } from '../lib/brand'
import { ImportExportBar } from '../components/ImportExportBar'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { Tabs } from '../ui/Tabs'
import { PromoFormModal } from './promotions/PromoFormModal'
import { DiscountCodeFormModal } from './promotions/DiscountCodeFormModal'
import { DiscountCodeBatchModal } from './promotions/DiscountCodeBatchModal'

const EMPTY_PROMO: PromotionInput = {
  name: '', description: '', type: 'percentage', value: 0, minPurchase: 0,
  applicableProductIds: [], applicableVariantKeys: [], isActive: true,
  combinable: false, codeOnly: false, outletIds: [], activeFromHour: '', activeToHour: '', activeDays: [],
}
const EMPTY_CODE: DiscountCodeInput = {
  code: '', type: 'percentage', value: 0, minPurchase: 0, usageLimit: 0, perCustomerLimit: undefined, isActive: true, combinable: false, promotionId: undefined, customerId: undefined,
}
const EMPTY_BATCH: DiscountCodeBatchInput = {
  count: 10, prefix: '', suffixLength: 6, type: 'percentage', value: 0, minPurchase: 0,
  usageLimit: 1, perCustomerLimit: undefined, isActive: true, combinable: false, promotionId: undefined,
}

const PROMO_TYPE_LABEL: Record<string, string> = {
  percentage: 'Persentase',
  fixed: 'Nominal',
  bogo: 'BOGO',
  buy_x_get_y: 'Beli-Gratis',
  tiered: 'Bertingkat',
  bundle: 'Paket Bundel',
}
const promoTypeLabel = (t: string): string => PROMO_TYPE_LABEL[t] ?? t

// Human value summary per promo type (list column + export).
const promoValueLabel = (p: Promotion): string => {
  if (p.type === 'percentage') return `${p.value}%`
  if (p.type === 'fixed') return BRAND.currency.format(p.value)
  if (p.type === 'bogo') return 'Buy 1 Get 1'
  if (p.type === 'buy_x_get_y') {
    const c = p.bxgyConfig
    if (!c) return 'Beli X, Gratis/Diskon Y'
    const deal =
      c.getDiscountKind === 'percentage' && c.getDiscountValue === 100
        ? 'Gratis'
        : c.getDiscountKind === 'percentage'
          ? `Diskon ${c.getDiscountValue}%`
          : `Potongan ${BRAND.currency.format(c.getDiscountValue)}`
    return `Beli ${c.buyQuantity}, ${deal} ${c.getQuantity}`
  }
  if (p.type === 'tiered') {
    const n = p.tieredConfig?.tiers?.length ?? 0
    return `${n} tingkat`
  }
  if (p.type === 'bundle') {
    return `Harga paket ${BRAND.currency.format(p.bundleConfig?.bundlePrice ?? 0)}`
  }
  return String(p.value)
}

const exportPromotions = async (fmt: 'csv' | 'xlsx') => {
  const data = await api.listPromotions()
  const rows = data.map((p) => ({
    Nama: p.name,
    Tipe: promoTypeLabel(p.type),
    Nilai: promoValueLabel(p),
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

export default function Promotions() {
  const prq = usePolledQuery<Promotion[]>(() => api.listPromotions(), [])
  const dcq = usePolledQuery<DiscountCode[]>(() => api.listDiscountCodes(), [])
  const pq = usePolledQuery<Product[]>(() => api.listProducts().then((r) => r.data.filter((p) => p.isActive)), [])
  const ouq = usePolledQuery<Outlet[]>(() => api.listOutlets(), [])
  const promotions = prq.data ?? []
  const codes = dcq.data ?? []
  const products = pq.data ?? []
  const outlets = ouq.data ?? []

  const [tab, setTab] = useState<'promotions' | 'codes'>('promotions')
  const [promoOpen, setPromoOpen] = useState(false)
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null)
  const [promoForm, setPromoForm] = useState<PromotionInput>(EMPTY_PROMO)
  const [variantPicker, setVariantPicker] = useState<string | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)
  const [editingCode, setEditingCode] = useState<DiscountCode | null>(null)
  const [codeForm, setCodeForm] = useState<DiscountCodeInput>(EMPTY_CODE)
  // Display-only name for codeForm.customerId — DiscountCodeInput has no customerName field
  // (that field only exists on the read-side DiscountCode type), so it's tracked separately.
  const [codeCustomerName, setCodeCustomerName] = useState<string>('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchForm, setBatchForm] = useState<DiscountCodeBatchInput>(EMPTY_BATCH)
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
      combinable: p.combinable ?? false, codeOnly: p.codeOnly ?? false,
      activeFromHour: p.activeFromHour || '', activeToHour: p.activeToHour || '',
      activeDays: p.activeDays || [], outletIds: p.outletIds ?? [],
      bxgyConfig: p.bxgyConfig ?? undefined,
      tieredConfig: p.tieredConfig ?? undefined, bundleConfig: p.bundleConfig ?? undefined,
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
      combinable: p.combinable ?? false, codeOnly: p.codeOnly ?? false,
      activeFromHour: p.activeFromHour || '', activeToHour: p.activeToHour || '',
      activeDays: p.activeDays || [], outletIds: p.outletIds ?? [],
      startDate: p.startDate || undefined,
      endDate: p.endDate || undefined, bxgyConfig: p.bxgyConfig ?? undefined,
      tieredConfig: p.tieredConfig ?? undefined, bundleConfig: p.bundleConfig ?? undefined,
    })
    await prq.refetch()
  }
  const togglePromo = async (p: Promotion) => {
    await api.updatePromotion(p.id, {
      name: p.name, description: p.description || '', type: p.type, value: p.value,
      minPurchase: p.minPurchase || 0, applicableProductIds: p.applicableProductIds || [],
      applicableVariantKeys: p.applicableVariantKeys || [], isActive: !p.isActive,
      combinable: p.combinable ?? false, codeOnly: p.codeOnly ?? false,
      activeFromHour: p.activeFromHour || '', activeToHour: p.activeToHour || '',
      activeDays: p.activeDays || [], outletIds: p.outletIds ?? [],
      startDate: p.startDate || undefined,
      endDate: p.endDate || undefined, bxgyConfig: p.bxgyConfig ?? undefined,
      tieredConfig: p.tieredConfig ?? undefined, bundleConfig: p.bundleConfig ?? undefined,
    })
    await prq.refetch()
  }

  const openEditCode = (c: DiscountCode) => {
    setEditingCode(c)
    setCodeForm({
      code: c.code, type: c.type, value: c.value, minPurchase: c.minPurchase || 0,
      usageLimit: c.usageLimit || 0, perCustomerLimit: c.perCustomerLimit ?? undefined,
      isActive: c.isActive, combinable: c.combinable ?? false,
      promotionId: c.promotionId ?? undefined,
      customerId: c.customerId ?? undefined,
      startDate: c.startDate || undefined, endDate: c.endDate || undefined,
    })
    setCodeCustomerName(c.customerName ?? '')
    setCodeOpen(true)
  }
  const saveCode = async () => {
    if (!codeForm.code.trim()) return
    setBusy(true)
    try {
      const body = {
        ...codeForm,
        code: codeForm.code.toUpperCase(),
        // Send undefined (omit) when empty so backend nulls it; send the id when linked
        promotionId: codeForm.promotionId || undefined,
      }
      if (editingCode) await api.updateDiscountCode(editingCode.id, body)
      else await api.createDiscountCode(body)
      setCodeOpen(false)
      await dcq.refetch()
    } finally {
      setBusy(false)
    }
  }
  const generateBatch = async () => {
    setBusy(true)
    try {
      const created = await api.createDiscountCodeBatch({
        ...batchForm,
        prefix: (batchForm.prefix || '').toUpperCase(),
      })
      await dcq.refetch()
      setBatchOpen(false)
      if (created.length) {
        exportToCSV(
          created.map((c) => ({ Kode: c.code, Tipe: c.type, Nilai: c.value, Kuota: c.usageLimit ?? 0 })),
          'kode-diskon-batch',
        )
      }
    } finally {
      setBusy(false)
    }
  }
  const toggleCode = async (c: DiscountCode) => {
    await api.updateDiscountCode(c.id, {
      code: c.code, type: c.type, value: c.value, minPurchase: c.minPurchase || 0,
      usageLimit: c.usageLimit || 0, perCustomerLimit: c.perCustomerLimit ?? undefined,
      isActive: !c.isActive, combinable: c.combinable ?? false,
      promotionId: c.promotionId ?? undefined,
      customerId: c.customerId ?? undefined,
      startDate: c.startDate || undefined, endDate: c.endDate || undefined,
    })
    await dcq.refetch()
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
            {tab === 'codes' && (
              <Button
                variant="secondary"
                icon={<Layers className="w-4 h-4" />}
                onClick={() => { setBatchForm({ ...EMPTY_BATCH }); setBatchOpen(true) }}
              >
                Buat Massal
              </Button>
            )}
            <Button
              icon={<Plus className="w-4 h-4" />}
              onClick={() =>
                tab === 'promotions'
                  ? (setEditingPromo(null), setPromoForm({ ...EMPTY_PROMO }), setPromoOpen(true))
                  : (setEditingCode(null), setCodeForm({ ...EMPTY_CODE }), setCodeCustomerName(''), setCodeOpen(true))
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
                          {p.codeOnly && <Badge tone="gold" className="inline-block mt-0.5 ml-1">Hanya kode</Badge>}
                        </td>
                        <td className="px-5 py-3"><Badge tone="gold">{promoTypeLabel(p.type)}</Badge></td>
                        <td className="px-5 py-3 font-bold text-gray-900 text-sm">{promoValueLabel(p)}</td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {p.startDate ? format(parseISO(p.startDate), 'dd MMM', { locale: idLocale }) : '—'} → {p.endDate ? format(parseISO(p.endDate), 'dd MMM yy', { locale: idLocale }) : '∞'}
                        </td>
                        <td className="px-5 py-3"><button type="button" onClick={() => togglePromo(p)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${st.color}`}>{st.label}</button></td>
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
                        {c.combinable && <Badge tone="gold" className="inline-block mt-0.5">Bisa Kombinasi</Badge>}
                        {c.promotionId && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Tertaut: {promotions.find((p) => p.id === c.promotionId)?.name ?? c.promotionId}
                          </p>
                        )}
                        {c.customerId && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            Khusus: {c.customerName ?? '—'}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3 font-bold text-gray-900 text-sm">{c.type === 'percentage' ? `${c.value}%` : BRAND.currency.format(c.value)}</td>
                      <td className="px-5 py-3 text-sm text-gray-600">{c.minPurchase ? BRAND.currency.format(c.minPurchase) : '—'}</td>
                      <td className="px-5 py-3 text-sm font-bold text-gray-900">{c.usageCount} / {c.usageLimit || '∞'}</td>
                      <td className="px-5 py-3"><button type="button" onClick={() => toggleCode(c)} className={`px-2.5 py-1 text-xs font-bold rounded-lg ${c.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{c.isActive ? 'Aktif' : 'Nonaktif'}</button></td>
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

      <PromoFormModal
        open={promoOpen}
        editingPromo={!!editingPromo}
        form={promoForm}
        setForm={setPromoForm}
        products={products}
        outlets={outlets}
        variantPicker={variantPicker}
        setVariantPicker={setVariantPicker}
        busy={busy}
        onSave={savePromo}
        onClose={() => setPromoOpen(false)}
      />

      <DiscountCodeFormModal
        open={codeOpen}
        editingCode={!!editingCode}
        form={codeForm}
        setForm={setCodeForm}
        promotions={promotions}
        customerName={codeCustomerName}
        onCustomerChange={(id, name) => { setCodeForm((f) => ({ ...f, customerId: id })); setCodeCustomerName(name) }}
        busy={busy}
        onSave={saveCode}
        onClose={() => setCodeOpen(false)}
      />

      <DiscountCodeBatchModal
        open={batchOpen}
        busy={busy}
        form={batchForm}
        setForm={setBatchForm}
        promotions={promotions}
        onGenerate={generateBatch}
        onClose={() => setBatchOpen(false)}
      />

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
