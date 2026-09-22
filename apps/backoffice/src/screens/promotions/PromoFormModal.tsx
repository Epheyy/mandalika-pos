import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Product, PromotionInput, Outlet } from '@mandalika/api'
import {
  ChevronDown,
  ChevronUp,
  Percent,
  Banknote,
  Gift,
  ShoppingBag,
  BarChart3,
  Package,
  type LucideIcon,
} from 'lucide-react'
import { BRAND } from '../../lib/brand'
import { Button } from '../../ui/Button'
import { Input, Select, Textarea, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { promotionKeyError } from './promotionKeyValidation'
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

type BundleSlotRow = { productKeys: string[]; quantity: number }

const DEFAULT_BUNDLE: { slots: BundleSlotRow[]; bundlePrice: number; maxApplications: number } = {
  slots: [{ productKeys: [], quantity: 1 }],
  bundlePrice: 0,
  maxApplications: 0,
}

type PromoType = PromotionInput['type']
const PROMO_TYPES: { value: PromoType; label: string; desc: string; icon: LucideIcon }[] = [
  { value: 'percentage', label: 'Persentase (%)', desc: 'Diskon persen dari total belanja', icon: Percent },
  { value: 'fixed', label: 'Nominal (Rp)', desc: 'Potongan rupiah tetap', icon: Banknote },
  { value: 'bogo', label: 'Buy 1 Get 1', desc: 'Beli 1 gratis 1 (barang termurah)', icon: Gift },
  { value: 'buy_x_get_y', label: 'Beli X, Gratis/Diskon Y', desc: 'Beli sejumlah barang, dapat hadiah/diskon', icon: ShoppingBag },
  { value: 'tiered', label: 'Bertingkat', desc: 'Belanja lebih, hemat lebih (tier)', icon: BarChart3 },
  { value: 'bundle', label: 'Paket Bundel', desc: 'Beli satu set produk sekaligus dengan harga paket tetap; item termurah jadi GRATIS', icon: Package },
]

// Horizontal 3-column icon cards replacing the plain type dropdown — each type
// shows a centered icon + name + a clamped one/two-line description so the user
// knows what it does before picking (6 types → 2 rows of 3).
function PromoTypePicker({ value, onChange }: { value: PromoType; onChange: (t: PromoType) => void }) {
  return (
    <Field label="Tipe Promosi">
      <div role="radiogroup" aria-label="Tipe promosi" className="grid grid-cols-3 gap-2">
        {PROMO_TYPES.map((t) => {
          const selected = value === t.value
          const Icon = t.icon
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(t.value)}
              className={`flex flex-col items-center text-center gap-1 p-3 rounded-xl border-2 transition-colors overflow-hidden ${
                selected ? 'border-gold-600 bg-gold-50' : 'border-gray-200 hover:border-gold-300 hover:bg-gray-50'
              }`}
            >
              <Icon className={`w-6 h-6 ${selected ? 'text-gold-600' : 'text-gray-400'}`} />
              <span className="text-xs font-bold text-gray-900">{t.label}</span>
              <span className="block text-[11px] text-gray-500 line-clamp-2">{t.desc}</span>
            </button>
          )
        })}
      </div>
    </Field>
  )
}

interface PromoFormModalProps {
  open: boolean
  editingPromo: boolean
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  products: Product[]
  outlets: Outlet[]
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
  outlets,
  variantPicker,
  setVariantPicker,
  busy,
  onSave,
  onClose,
}: PromoFormModalProps) {
  // Local UI-only state: the active wizard step, whether the "Tentukan hari &
  // jam" schedule section and the outlet multi-select dropdown are expanded.
  // Purely presentational — does not touch form state, validation, or the save gate.
  const [step, setStep] = useState(0)
  const [schedOpen, setSchedOpen] = useState(false)
  const [outletOpen, setOutletOpen] = useState(false)

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
  const toggleOutlet = (id: string) =>
    setForm((f) => ({
      ...f,
      outletIds: (f.outletIds || []).includes(id)
        ? (f.outletIds || []).filter((x) => x !== id)
        : [...(f.outletIds || []), id],
    }))
  // Toggling the "Tentukan hari & jam" switch off clears the schedule fields so
  // a hidden gate (e.g. a stale hoursError) can't linger once the section is hidden.
  const toggleSched = (next: boolean) => {
    setSchedOpen(next)
    if (!next) {
      setForm((f) => ({ ...f, activeDays: [], activeFromHour: '', activeToHour: '' }))
    }
  }
  const setBxgy = (patch: Partial<typeof DEFAULT_BXGY>) =>
    setForm((f) => ({ ...f, bxgyConfig: { ...(f.bxgyConfig ?? DEFAULT_BXGY), ...patch } }))

  const setTiers = (tiers: TierRow[]) =>
    setForm((f) => ({ ...f, tieredConfig: { tiers } }))

  const setBundle = (patch: Partial<typeof DEFAULT_BUNDLE>) =>
    setForm((f) => ({ ...f, bundleConfig: { ...(f.bundleConfig ?? DEFAULT_BUNDLE), ...patch } }))

  const setSlots = (slots: BundleSlotRow[]) => setBundle({ slots })

  // Selecting a type seeds its default config (same logic the old dropdown ran).
  const selectType = (type: PromoType) =>
    setForm((f) => ({
      ...f,
      type,
      bxgyConfig: type === 'buy_x_get_y' ? (f.bxgyConfig ?? DEFAULT_BXGY) : f.bxgyConfig,
      tieredConfig: type === 'tiered' ? (f.tieredConfig ?? DEFAULT_TIERED) : f.tieredConfig,
      bundleConfig: type === 'bundle' ? (f.bundleConfig ?? DEFAULT_BUNDLE) : f.bundleConfig,
    }))

  const tiers: TierRow[] = (form.tieredConfig?.tiers ?? []) as TierRow[]
  const slots: BundleSlotRow[] = (form.bundleConfig?.slots ?? []) as BundleSlotRow[]

  const keyError = promotionKeyError(form)
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

  // Mirrors backend write.validateBundle: >=1 slot, each slot has >=1 key and
  // quantity >= 1, bundlePrice > 0, and no productKey may appear in two slots.
  const bundleError = (() => {
    if (form.type !== 'bundle') return null
    if (slots.length === 0) return 'Harus ada minimal 1 slot.'
    const seen = new Set<string>()
    for (const s of slots) {
      if (!s.productKeys || s.productKeys.length === 0) return 'Setiap slot harus punya minimal 1 produk.'
      if (s.quantity < 1) return 'Jumlah tiap slot minimal 1.'
      for (const k of s.productKeys) {
        if (seen.has(k)) return 'Produk tidak boleh dipakai di lebih dari satu slot.'
        seen.add(k)
      }
    }
    if (!form.bundleConfig || form.bundleConfig.bundlePrice <= 0) return 'Harga paket harus lebih dari 0.'
    return null
  })()

  const hoursError = (() => {
    const from = form.activeFromHour || ''
    const to = form.activeToHour || ''
    if ((from === '') !== (to === '')) return 'Isi kedua jam aktif atau kosongkan keduanya.'
    if (from !== '' && to !== '' && from > to)
      return 'Jam mulai harus lebih awal dari jam selesai (rentang lewat tengah malam tidak didukung).'
    return null
  })()
  const maxAppError = (() => {
    if (form.type === 'buy_x_get_y' && (form.bxgyConfig?.maxApplications ?? 0) < 0)
      return 'Maks/transaksi tidak boleh negatif.'
    if (form.type === 'bundle' && (form.bundleConfig?.maxApplications ?? 0) < 0)
      return 'Maks. kelipatan tidak boleh negatif.'
    return null
  })()

  // PromoFormModal itself stays mounted across open/close (Modal only unmounts
  // its own body), so step/schedOpen would otherwise carry over from the
  // previous promo. Re-derive both every time the modal opens: always start on
  // step 0, and expand the schedule section when editing an existing promo that
  // already has days/hours set.
  useEffect(() => {
    if (!open) return
    setStep(0)
    setSchedOpen((form.activeDays?.length ?? 0) > 0 || !!form.activeFromHour || !!form.activeToHour)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const showVariantPicker = form.type !== 'buy_x_get_y' && form.type !== 'tiered' && form.type !== 'bundle'

  const STEPS = ['Umum', 'Jenis Promosi', 'Lokasi & Ketentuan']
  // Per-step error flags so the sidebar can flag whichever step holds a
  // validation error — reuses the existing validators, no new ones.
  const stepHasError = [!!hoursError, !!keyError || !!tieredError || !!bundleError || !!maxAppError, false]

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      title={editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          {step > 0 && (
            <Button variant="secondary" className="flex-1" onClick={() => setStep(step - 1)}>Kembali</Button>
          )}
          {step < 2 ? (
            <Button className="flex-1" onClick={() => setStep(step + 1)}>Lanjutkan</Button>
          ) : (
            <Button className="flex-1" loading={busy} disabled={!!keyError || !!tieredError || !!bundleError || !!hoursError || !!maxAppError} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
          )}
        </>
      }
    >
      <div className="flex gap-6">
        <nav className="w-44 shrink-0 space-y-1">
          {STEPS.map((label, i) => {
            const active = step === i
            const errored = stepHasError[i]
            return (
              <button
                key={label}
                type="button"
                onClick={() => setStep(i)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-colors ${
                  active ? 'bg-gold-50' : 'hover:bg-gray-50'
                }`}
              >
                <span
                  className={`relative flex items-center justify-center w-7 h-7 rounded-full text-xs font-black shrink-0 ${
                    active ? 'bg-gold-600 text-white' : 'bg-gray-100 text-gray-500'
                  } ${errored ? 'ring-2 ring-red-500 ring-offset-1' : ''}`}
                >
                  {i + 1}
                  {errored && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />}
                </span>
                <span className={`text-sm ${active ? 'font-black text-gold-700' : 'font-bold text-gray-600'}`}>{label}</span>
              </button>
            )
          })}
        </nav>

        <div className="flex-1 min-w-0 space-y-4">
        {step === 0 && (
          <>
            <Input label="Nama Promosi *" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Textarea label="Deskripsi" value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 accent-gold-600" />
              <span className="text-sm font-bold text-gray-700">Promosi Aktif</span>
            </label>

            <div className="grid grid-cols-2 gap-4">
              <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
              <Input label="Berakhir" type="date" value={form.endDate || ''} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>

            <div>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-gray-200 cursor-pointer hover:bg-gray-50">
                <span className="text-sm font-bold text-gray-700">Tentukan hari & jam</span>
                <input type="checkbox" checked={schedOpen} onChange={(e) => toggleSched(e.target.checked)} className="w-4 h-4 accent-gold-600 shrink-0" />
              </label>

              {schedOpen && (
                <div className="space-y-4 mt-3">
                  <Field label="Aktif Hari (kosong = semua)">
                    <div className="flex gap-1.5 flex-wrap">
                      {DAYS.map((d, i) => (
                        <button key={d} type="button" onClick={() => toggleDay(i)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 ${(form.activeDays || []).includes(i) ? 'bg-gold-600 text-white border-gold-600' : 'border-gray-200 text-gray-600'}`}>{d}</button>
                      ))}
                    </div>
                  </Field>

                  <Field label="Jam Aktif (kosong = sepanjang hari)">
                    <div className="grid grid-cols-2 gap-4">
                      <Input label="Dari" type="time" value={form.activeFromHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeFromHour: e.target.value }))} />
                      <Input label="Sampai" type="time" value={form.activeToHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeToHour: e.target.value }))} />
                    </div>
                    {hoursError && <p className="text-xs text-red-600 font-semibold mt-1">{hoursError}</p>}
                  </Field>
                </div>
              )}
            </div>
          </>
        )}

        {step === 1 && (
        <>
        <PromoTypePicker value={form.type} onChange={selectType} />
        {form.type !== 'bogo' && form.type !== 'buy_x_get_y' && form.type !== 'tiered' && form.type !== 'bundle' && (
          <Input label="Nilai" type="number" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
        )}
        {form.type === 'buy_x_get_y' && (
          <div className="space-y-4 p-3 bg-gold-50 rounded-xl">
            <div className="grid grid-cols-3 gap-3">
              <Input label="Beli (X)" type="number" value={form.bxgyConfig?.buyQuantity ?? 2}
                onChange={(e) => setBxgy({ buyQuantity: parseInt(e.target.value) || 0 })} />
              <Input label="Dapat (Y)" type="number" value={form.bxgyConfig?.getQuantity ?? 1}
                onChange={(e) => setBxgy({ getQuantity: parseInt(e.target.value) || 0 })} />
              <Input label="Maks/transaksi (0=∞)" type="number" min={0} value={form.bxgyConfig?.maxApplications ?? 0}
                onChange={(e) => setBxgy({ maxApplications: parseInt(e.target.value) || 0 })} />
            </div>
            {maxAppError && <p className="text-xs text-red-600 font-semibold">{maxAppError}</p>}
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
            {keyError && <p className="text-xs text-red-600 font-semibold" role="alert">{keyError}</p>}
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
        {form.type === 'bundle' && (
          <div className="space-y-3 p-3 bg-gold-50 rounded-xl">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Slot Paket</p>
            {slots.map((slot, idx) => (
              <div key={idx} className="space-y-2 p-2.5 bg-white rounded-lg border border-gray-200">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Slot {idx + 1}</p>
                  <button
                    type="button"
                    onClick={() => setSlots(slots.filter((_, i) => i !== idx))}
                    className="flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 text-lg font-bold"
                    aria-label="Hapus slot"
                  >×</button>
                </div>
                <ProductVariantPicker
                  products={products}
                  value={slot.productKeys}
                  onChange={(next) => setSlots(slots.map((s, i) => (i === idx ? { ...s, productKeys: next } : s)))}
                />
                <Input
                  label="Jumlah"
                  type="number"
                  min={1}
                  value={slot.quantity}
                  onChange={(e) => setSlots(slots.map((s, i) => (i === idx ? { ...s, quantity: parseInt(e.target.value) || 1 } : s)))}
                />
              </div>
            ))}
            {keyError && <p className="text-xs text-red-600 font-semibold" role="alert">{keyError}</p>}
            {bundleError && <p className="text-xs text-red-600 font-semibold">{bundleError}</p>}
            <Button
              variant="secondary"
              onClick={() => setSlots([...slots, { productKeys: [], quantity: 1 }])}
            >+ Tambah slot</Button>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Harga paket (Rp)" type="number" value={form.bundleConfig?.bundlePrice ?? 0}
                onChange={(e) => setBundle({ bundlePrice: parseFloat(e.target.value) || 0 })} />
              <Input label="Maks. kelipatan (0 = tanpa batas)" type="number" min={0} value={form.bundleConfig?.maxApplications ?? 0}
                onChange={(e) => setBundle({ maxApplications: parseInt(e.target.value) || 0 })} />
            </div>
            {maxAppError && <p className="text-xs text-red-600 font-semibold">{maxAppError}</p>}
          </div>
        )}

        </>
        )}

        {step === 2 && (
        <>
          <Field label="Outlet (kosong = semua outlet)">
            <button
              type="button"
              onClick={() => setOutletOpen((o) => !o)}
              className="w-full flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-left hover:bg-gray-50 transition-colors"
            >
              <span className="text-sm font-bold text-gray-700">
                {(form.outletIds || []).length === 0 ? 'Semua outlet' : `${(form.outletIds || []).length} outlet dipilih`}
              </span>
              {outletOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
            </button>
            {outletOpen && (
              <div className="mt-1 max-h-48 overflow-y-auto space-y-0.5 border border-gray-200 rounded-xl p-2">
                {outlets.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-lg px-2 py-1.5">
                    <input type="checkbox" checked={(form.outletIds || []).includes(o.id)} onChange={() => toggleOutlet(o.id)} className="accent-gold-600" />
                    <span className="text-xs text-gray-600">{o.name}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          <Input label="Minimum Pembelian (Rp)" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />

          <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-gray-200 cursor-pointer hover:bg-gray-50">
            <span className="text-sm font-bold text-gray-700">Bisa dikombinasikan dengan promosi lain</span>
            <input type="checkbox" checked={form.combinable ?? false} onChange={(e) => setForm((f) => ({ ...f, combinable: e.target.checked }))} className="w-4 h-4 accent-gold-600 shrink-0" />
          </label>

          <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-gray-200 cursor-pointer hover:bg-gray-50">
            <span className="text-sm font-bold text-gray-700">Hanya via kode (sembunyikan dari panel kasir)</span>
            <input type="checkbox" checked={form.codeOnly ?? false} onChange={(e) => setForm((f) => ({ ...f, codeOnly: e.target.checked }))} className="w-4 h-4 accent-gold-600 shrink-0" />
          </label>

          {showVariantPicker && (
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
        </>
        )}
        </div>
      </div>
    </Modal>
  )
}
