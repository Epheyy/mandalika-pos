import type { Dispatch, SetStateAction } from 'react'
import type { Product, PromotionInput } from '@mandalika/api'
import { Banknote, BarChart3, Gift, Package, Percent, ShoppingBag, type LucideIcon } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Field, Input, Select } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { ProductVariantPicker } from '../customers/ProductVariantPicker'
import {
  DEFAULT_BUNDLE,
  DEFAULT_BXGY,
  DEFAULT_TIERED,
  PROMO_FIELD,
  type BundleSlotRow,
  type PromoType,
  type TierRow,
} from './promotionForm'

const PROMO_TYPES: { value: PromoType; label: string; desc: string; icon: LucideIcon }[] = [
  { value: 'percentage', label: 'Persentase (%)', desc: 'Diskon persen dari total belanja', icon: Percent },
  { value: 'fixed', label: 'Nominal (Rp)', desc: 'Potongan rupiah tetap', icon: Banknote },
  { value: 'bogo', label: 'Buy 1 Get 1', desc: 'Beli 1 gratis 1 (barang termurah)', icon: Gift },
  { value: 'buy_x_get_y', label: 'Beli X, Gratis/Diskon Y', desc: 'Beli sejumlah barang, dapat hadiah/diskon', icon: ShoppingBag },
  { value: 'tiered', label: 'Bertingkat', desc: 'Belanja lebih, hemat lebih (tier)', icon: BarChart3 },
  { value: 'bundle', label: 'Paket Bundel', desc: 'Beli satu set produk sekaligus dengan harga paket tetap; item termurah jadi GRATIS', icon: Package },
]

function PromoTypePicker({ value, onChange }: { value: PromoType; onChange: (t: PromoType) => void }) {
  return (
    <Field label="Jenis Promosi">
      <div role="radiogroup" aria-label="Jenis promosi" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
              className={cn(
                'flex flex-col items-center gap-1 overflow-hidden rounded-xl border-2 p-3 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong',
                selected ? 'border-brand-strong bg-paper-1' : 'border-paper-2 hover:bg-paper-1',
              )}
            >
              <Icon className={cn('h-6 w-6', selected ? 'text-brand-strong' : 'text-ink-500')} aria-hidden="true" />
              <span className="text-xs font-bold text-ink-900">{t.label}</span>
              <span className="line-clamp-2 block text-[11px] text-ink-700">{t.desc}</span>
            </button>
          )
        })}
      </div>
    </Field>
  )
}

const errorText = (msg?: string) => (msg ? <p role="alert" className="text-xs font-semibold text-danger">{msg}</p> : null)

interface PromoTypeFieldsProps {
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  products: Product[]
  /** Problem messages by field id (see PROMO_FIELD). */
  errors: Readonly<Record<string, string>>
}

/** The jenis picker and the fields of the chosen jenis. Switching jenis seeds its default config only when it has none. */
export function PromoTypeFields({ form, setForm, products, errors }: PromoTypeFieldsProps) {
  const setBxgy = (patch: Partial<typeof DEFAULT_BXGY>) =>
    setForm((f) => ({ ...f, bxgyConfig: { ...(f.bxgyConfig ?? DEFAULT_BXGY), ...patch } }))
  const setTiers = (tiers: TierRow[]) => setForm((f) => ({ ...f, tieredConfig: { tiers } }))
  const setBundle = (patch: Partial<typeof DEFAULT_BUNDLE>) =>
    setForm((f) => ({ ...f, bundleConfig: { ...(f.bundleConfig ?? DEFAULT_BUNDLE), ...patch } }))
  const selectType = (type: PromoType) =>
    setForm((f) => ({
      ...f,
      type,
      bxgyConfig: type === 'buy_x_get_y' ? (f.bxgyConfig ?? DEFAULT_BXGY) : f.bxgyConfig,
      tieredConfig: type === 'tiered' ? (f.tieredConfig ?? DEFAULT_TIERED) : f.tieredConfig,
      bundleConfig: type === 'bundle' ? (f.bundleConfig ?? DEFAULT_BUNDLE) : f.bundleConfig,
    }))

  const tiers = (form.tieredConfig?.tiers ?? []) as TierRow[]
  const slots = (form.bundleConfig?.slots ?? []) as BundleSlotRow[]
  const setSlots = (next: BundleSlotRow[]) => setBundle({ slots: next })
  const plainValue = form.type === 'percentage' || form.type === 'fixed'

  return (
    <div className="space-y-4">
      <PromoTypePicker value={form.type} onChange={selectType} />

      {plainValue && (
        <Input id={PROMO_FIELD.value} label={form.type === 'percentage' ? 'Nilai Diskon (1% – 100%) *' : 'Nilai Diskon (Rp) *'} type="number" value={form.value} error={errors[PROMO_FIELD.value]} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
      )}

      {form.type === 'buy_x_get_y' && (
        <div className="space-y-4 rounded-xl bg-paper-1 p-3">
          <div className="grid grid-cols-3 gap-3">
            <Input label="Beli (X)" type="number" value={form.bxgyConfig?.buyQuantity ?? 2} onChange={(e) => setBxgy({ buyQuantity: parseInt(e.target.value) || 0 })} />
            <Input label="Dapat (Y)" type="number" value={form.bxgyConfig?.getQuantity ?? 1} onChange={(e) => setBxgy({ getQuantity: parseInt(e.target.value) || 0 })} />
            <Input
              id={PROMO_FIELD.maxApplications}
              label="Maks/transaksi (0=∞)"
              type="number"
              min={0}
              value={form.bxgyConfig?.maxApplications ?? 0}
              error={errors[PROMO_FIELD.maxApplications]}
              onChange={(e) => setBxgy({ maxApplications: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Diskon Y" value={form.bxgyConfig?.getDiscountKind ?? 'percentage'} onChange={(e) => setBxgy({ getDiscountKind: e.target.value as 'percentage' | 'fixed' })}>
              <option value="percentage">Persentase (%)</option>
              <option value="fixed">Nominal (Rp)</option>
            </Select>
            <div className="flex items-end gap-2">
              <Input label="Nilai diskon Y" type="number" value={form.bxgyConfig?.getDiscountValue ?? 100} onChange={(e) => setBxgy({ getDiscountValue: parseFloat(e.target.value) || 0 })} />
              <Button variant="secondary" onClick={() => setBxgy({ getDiscountKind: 'percentage', getDiscountValue: 100 })}>Gratis</Button>
            </div>
          </div>
          <div id={PROMO_FIELD.products} tabIndex={-1}>{errorText(errors[PROMO_FIELD.products])}</div>
          <Field label="Produk Beli (kosong = semua produk)">
            <ProductVariantPicker products={products} value={form.bxgyConfig?.buyProductIds ?? []} onChange={(next) => setBxgy({ buyProductIds: next })} />
          </Field>
          <Field label="Produk Hadiah (diberikan gratis/diskon ke pelanggan)" hint="Pelanggan menerima produk ini sebagai hadiah saat memenuhi syarat beli.">
            <ProductVariantPicker products={products} value={form.bxgyConfig?.getProductIds ?? []} onChange={(next) => setBxgy({ getProductIds: next })} />
          </Field>
        </div>
      )}

      {form.type === 'tiered' && (
        <div id={PROMO_FIELD.tiers} tabIndex={-1} className="space-y-3 rounded-xl bg-paper-1 p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-ink-700">Tingkatan Diskon</p>
          {[...tiers].sort((a, b) => a.minSubtotal - b.minSubtotal).map((tier) => {
            const at = tiers.indexOf(tier)
            const patch = (p: Partial<TierRow>) => setTiers(tiers.map((t, i) => (i === at ? { ...t, ...p } : t)))
            return (
              <div key={at} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                <Input label="Min. belanja (Rp)" type="number" value={tier.minSubtotal} onChange={(e) => patch({ minSubtotal: parseFloat(e.target.value) || 0 })} />
                <Select label="Tipe" value={tier.kind} onChange={(e) => patch({ kind: e.target.value as 'percentage' | 'fixed' })}>
                  <option value="percentage">Persentase (%)</option>
                  <option value="fixed">Nominal (Rp)</option>
                </Select>
                <Input label="Nilai" type="number" value={tier.value} onChange={(e) => patch({ value: parseFloat(e.target.value) || 0 })} />
                <button
                  type="button"
                  onClick={() => setTiers(tiers.filter((_, i) => i !== at))}
                  className="mb-0.5 flex h-9 w-9 items-center justify-center rounded-lg text-lg font-bold text-ink-500 hover:bg-danger-bg hover:text-danger"
                  aria-label="Hapus tingkat"
                >×</button>
              </div>
            )
          })}
          {errorText(errors[PROMO_FIELD.tiers])}
          <Button variant="secondary" onClick={() => setTiers([...tiers, { minSubtotal: 0, kind: 'percentage', value: 10 }])}>+ Tambah tingkat</Button>
        </div>
      )}

      {form.type === 'bundle' && (
        <div id={PROMO_FIELD.bundle} tabIndex={-1} className="space-y-3 rounded-xl bg-paper-1 p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-ink-700">Slot Paket</p>
          {slots.map((slot, idx) => (
            <div key={idx} className="space-y-2 rounded-lg border border-paper-2 bg-white p-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">Slot {idx + 1}</p>
                <button
                  type="button"
                  onClick={() => setSlots(slots.filter((_, i) => i !== idx))}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-lg font-bold text-ink-500 hover:bg-danger-bg hover:text-danger"
                  aria-label="Hapus slot"
                >×</button>
              </div>
              <ProductVariantPicker products={products} value={slot.productKeys} onChange={(next) => setSlots(slots.map((s, i) => (i === idx ? { ...s, productKeys: next } : s)))} />
              <Input label="Jumlah" type="number" min={1} value={slot.quantity} onChange={(e) => setSlots(slots.map((s, i) => (i === idx ? { ...s, quantity: parseInt(e.target.value) || 1 } : s)))} />
            </div>
          ))}
          <div id={PROMO_FIELD.products} tabIndex={-1}>{errorText(errors[PROMO_FIELD.products])}</div>
          {errorText(errors[PROMO_FIELD.bundle])}
          <Button variant="secondary" onClick={() => setSlots([...slots, { productKeys: [], quantity: 1 }])}>+ Tambah slot</Button>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Harga paket (Rp)" type="number" value={form.bundleConfig?.bundlePrice ?? 0} onChange={(e) => setBundle({ bundlePrice: parseFloat(e.target.value) || 0 })} />
            <Input
              id={PROMO_FIELD.maxApplications}
              label="Maks. kelipatan (0 = tanpa batas)"
              type="number"
              min={0}
              value={form.bundleConfig?.maxApplications ?? 0}
              error={errors[PROMO_FIELD.maxApplications]}
              onChange={(e) => setBundle({ maxApplications: parseInt(e.target.value) || 0 })}
            />
          </div>
        </div>
      )}
    </div>
  )
}
