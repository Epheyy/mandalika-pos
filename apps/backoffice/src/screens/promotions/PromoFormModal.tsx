import type { Dispatch, SetStateAction } from 'react'
import type { Product, PromotionInput } from '@mandalika/api'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Input, Select, Textarea, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { ProductVariantPicker } from '../customers/ProductVariantPicker'

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

const DEFAULT_BXGY: {
  buyQuantity: number
  getQuantity: number
  buyProductIds: string[]
  getProductIds: string[]
  getDiscountKind: 'percentage' | 'fixed'
  getDiscountValue: number
  maxApplications: number
} = {
  buyQuantity: 2,
  getQuantity: 1,
  buyProductIds: [],
  getProductIds: [],
  getDiscountKind: 'percentage',
  getDiscountValue: 100,
  maxApplications: 0,
}

type TierRow = { minSubtotal: number; kind: 'percentage' | 'fixed'; value: number }

const DEFAULT_TIERED: { tiers: TierRow[] } = {
  tiers: [{ minSubtotal: 100000, kind: 'percentage', value: 10 }],
}

interface PromoFormModalProps {
  open: boolean
  editingPromo: boolean
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  products: Product[]
  variantPicker: string | null
  setVariantPicker: Dispatch<SetStateAction<string | null>>
  busy: boolean
  onSave: () => void
  onClose: () => void
}

export function PromoFormModal({
  open,
  editingPromo,
  form,
  setForm,
  products,
  variantPicker,
  setVariantPicker,
  busy,
  onSave,
  onClose,
}: PromoFormModalProps) {
  const toggleVariant = (pid: string, size: string) => {
    const key = `${pid}::${size}`
    setForm((f) => ({
      ...f,
      applicableVariantKeys: (f.applicableVariantKeys || []).includes(key)
        ? (f.applicableVariantKeys || []).filter((k) => k !== key)
        : [...(f.applicableVariantKeys || []), key],
    }))
  }
  const toggleDay = (d: number) =>
    setForm((f) => ({
      ...f,
      activeDays: (f.activeDays || []).includes(d)
        ? (f.activeDays || []).filter((x) => x !== d)
        : [...(f.activeDays || []), d],
    }))
  const setBxgy = (patch: Partial<typeof DEFAULT_BXGY>) =>
    setForm((f) => ({ ...f, bxgyConfig: { ...(f.bxgyConfig ?? DEFAULT_BXGY), ...patch } }))

  const setTiers = (tiers: TierRow[]) =>
    setForm((f) => ({ ...f, tieredConfig: { tiers } }))

  const tiers: TierRow[] = (form.tieredConfig?.tiers ?? []) as TierRow[]

  const tieredError = (() => {
    if (form.type !== 'tiered') return null
    if (tiers.length === 0) return 'Harus ada minimal 1 tingkat.'
    const seen = new Set<number>()
    for (const t of tiers) {
      if (t.minSubtotal < 0) return 'Min. belanja tidak boleh negatif.'
      if (t.kind !== 'percentage' && t.kind !== 'fixed') return 'Tipe diskon tidak valid.'
      if (t.kind === 'percentage' && (t.value <= 0 || t.value > 100)) return 'Persentase harus antara 0 dan 100.'
      if (t.kind === 'fixed' && t.value <= 0) return 'Nominal harus lebih dari 0.'
      if (seen.has(t.minSubtotal)) return `Min. belanja Rp ${t.minSubtotal.toLocaleString('id-ID')} duplikat.`
      seen.add(t.minSubtotal)
    }
    return null
  })()

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" loading={busy} disabled={!!tieredError} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nama Promosi *" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <Textarea label="Deskripsi" value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        <div className="grid grid-cols-2 gap-4">
          <Select label="Tipe" value={form.type} onChange={(e) => {
            const type = e.target.value as PromotionInput['type']
            setForm((f) => ({
              ...f,
              type,
              bxgyConfig: type === 'buy_x_get_y' ? (f.bxgyConfig ?? DEFAULT_BXGY) : f.bxgyConfig,
              tieredConfig: type === 'tiered' ? (f.tieredConfig ?? DEFAULT_TIERED) : f.tieredConfig,
            }))
          }}>
            <option value="percentage">Persentase (%)</option>
            <option value="fixed">Nominal (Rp)</option>
            <option value="bogo">Buy 1 Get 1</option>
            <option value="buy_x_get_y">Beli X, Gratis/Diskon Y</option>
            <option value="tiered">Bertingkat — belanja lebih, hemat lebih</option>
          </Select>
          {form.type !== 'bogo' && form.type !== 'buy_x_get_y' && form.type !== 'tiered' && (
            <Input label="Nilai" type="number" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
          )}
        </div>
        {form.type === 'buy_x_get_y' && (
          <div className="space-y-4 p-3 bg-gold-50 rounded-xl">
            <div className="grid grid-cols-3 gap-3">
              <Input label="Beli (X)" type="number" value={form.bxgyConfig?.buyQuantity ?? 2}
                onChange={(e) => setBxgy({ buyQuantity: parseInt(e.target.value) || 0 })} />
              <Input label="Dapat (Y)" type="number" value={form.bxgyConfig?.getQuantity ?? 1}
                onChange={(e) => setBxgy({ getQuantity: parseInt(e.target.value) || 0 })} />
              <Input label="Maks/transaksi (0=∞)" type="number" value={form.bxgyConfig?.maxApplications ?? 0}
                onChange={(e) => setBxgy({ maxApplications: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select label="Diskon Y" value={form.bxgyConfig?.getDiscountKind ?? 'percentage'}
                onChange={(e) => setBxgy({ getDiscountKind: e.target.value as 'percentage' | 'fixed' })}>
                <option value="percentage">Persentase (%)</option>
                <option value="fixed">Nominal (Rp)</option>
              </Select>
              <div className="flex items-end gap-2">
                <Input label="Nilai diskon Y" type="number" value={form.bxgyConfig?.getDiscountValue ?? 100}
                  onChange={(e) => setBxgy({ getDiscountValue: parseFloat(e.target.value) || 0 })} />
                <Button variant="secondary" onClick={() => setBxgy({ getDiscountKind: 'percentage', getDiscountValue: 100 })}>Gratis</Button>
              </div>
            </div>
            <Field label="Produk Beli (kosong = semua produk)">
              <ProductVariantPicker products={products} value={form.bxgyConfig?.buyProductIds ?? []}
                onChange={(next) => setBxgy({ buyProductIds: next })} />
            </Field>
            <Field label="Produk Hadiah (diberikan gratis/diskon ke pelanggan)" hint="Pelanggan menerima produk ini sebagai hadiah saat memenuhi syarat beli.">
              <ProductVariantPicker products={products} value={form.bxgyConfig?.getProductIds ?? []}
                onChange={(next) => setBxgy({ getProductIds: next })} />
            </Field>
          </div>
        )}
        {form.type === 'tiered' && (
          <div className="space-y-3 p-3 bg-gold-50 rounded-xl">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Tingkatan Diskon</p>
            {[...tiers].sort((a, b) => a.minSubtotal - b.minSubtotal).map((tier, idx) => {
              const origIdx = tiers.indexOf(tier)
              return (
                <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                  <Input
                    label="Min. belanja (Rp)"
                    type="number"
                    value={tier.minSubtotal}
                    onChange={(e) => {
                      const next = tiers.map((t, i) => i === origIdx ? { ...t, minSubtotal: parseFloat(e.target.value) || 0 } : t)
                      setTiers(next)
                    }}
                  />
                  <Select
                    label="Tipe"
                    value={tier.kind}
                    onChange={(e) => {
                      const next = tiers.map((t, i) => i === origIdx ? { ...t, kind: e.target.value as 'percentage' | 'fixed' } : t)
                      setTiers(next)
                    }}
                  >
                    <option value="percentage">Persentase (%)</option>
                    <option value="fixed">Nominal (Rp)</option>
                  </Select>
                  <Input
                    label="Nilai"
                    type="number"
                    value={tier.value}
                    onChange={(e) => {
                      const next = tiers.map((t, i) => i === origIdx ? { ...t, value: parseFloat(e.target.value) || 0 } : t)
                      setTiers(next)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setTiers(tiers.filter((_, i) => i !== origIdx))}
                    className="mb-0.5 flex items-center justify-center w-8 h-8 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 text-lg font-bold"
                    aria-label="Hapus tingkat"
                  >×</button>
                </div>
              )
            })}
            {tieredError && <p className="text-xs text-red-600 font-semibold">{tieredError}</p>}
            <Button
              variant="secondary"
              onClick={() => setTiers([...tiers, { minSubtotal: 0, kind: 'percentage', value: 10 }])}
            >+ Tambah tingkat</Button>
          </div>
        )}
        <Input label="Minimum Pembelian (Rp)" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
          <Input label="Berakhir" type="date" value={form.endDate || ''} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
        </div>
        <Field label="Aktif Hari (kosong = semua)">
          <div className="flex gap-1.5 flex-wrap">
            {DAYS.map((d, i) => (
              <button key={d} type="button" onClick={() => toggleDay(i)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(form.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
            ))}
          </div>
        </Field>
        <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.combinable ?? false} onChange={(e) => setForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
          <span className="text-sm font-bold text-gray-900">Bisa dikombinasikan dengan promosi lain</span>
        </label>
        <label className="flex items-start gap-3 p-3 bg-gold-50 rounded-xl cursor-pointer">
          <input type="checkbox" checked={form.codeOnly ?? false} onChange={(e) => setForm((f) => ({ ...f, codeOnly: e.target.checked }))} className="w-4 h-4 accent-gold-600 mt-0.5" />
          <span className="text-sm font-bold text-gray-900">Hanya via kode (sembunyikan dari panel kasir)</span>
        </label>
        {form.type !== 'buy_x_get_y' && form.type !== 'tiered' && (
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
                            <input type="checkbox" checked={(form.applicableVariantKeys || []).includes(key)} onChange={() => toggleVariant(p.id, v.size)} className="accent-gold-600" />
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
        )}
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
          <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
        </label>
      </div>
    </Modal>
  )
}
