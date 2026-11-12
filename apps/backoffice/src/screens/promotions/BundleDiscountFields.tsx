import { useState, type Dispatch, type SetStateAction } from 'react'
import type { PromotionInput } from '@mandalika/api'
import { Input } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { DEFAULT_BUNDLE_DISCOUNT, PROMO_FIELD, type BundleDiscountConfig } from './promotionForm'

const SEG = 'h-9 px-3 text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong'
const SEG_ON = 'bg-ink-900 text-white'
const SEG_OFF = 'bg-white text-ink-700 hover:bg-paper-1'

function Seg({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-paper-2">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn(SEG, value === o.value ? SEG_ON : SEG_OFF)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CheckChips({ label, items, value, empty, onChange }: { label: string; items: readonly { key: string; label: string }[]; value: readonly string[]; empty: string; onChange: (next: string[]) => void }) {
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  // A stored key the list no longer knows stays visible, so an edit cannot silently drop it.
  const known = new Set(items.map((i) => i.key))
  const all = [...items, ...value.filter((k) => !known.has(k)).map((k) => ({ key: k, label: k }))]
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="w-14 text-xs font-bold text-ink-700">{label}</span>
      {all.map((i) => {
        const on = value.includes(i.key)
        return (
          <label key={i.key} className={cn('inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] font-bold', on ? 'border-brand-strong bg-paper-1 text-ink-900' : 'border-paper-2 bg-white text-ink-700 hover:bg-paper-1')}>
            <input type="checkbox" checked={on} onChange={() => toggle(i.key)} className="h-4 w-4 accent-brand-strong" />
            {i.label}
          </label>
        )
      })}
      {value.length === 0 && <span className="text-xs text-ink-500">{empty}</span>}
    </div>
  )
}

interface BundleDiscountFieldsProps {
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  lines: readonly { line: string; label: string }[]
  sizes: readonly string[]
  errors: Readonly<Record<string, string>>
}

/** Diskon Bundle: persen or nominal per bundle, and which bundles it covers (empty lines/sizes = all). */
export function BundleDiscountFields({ form, setForm, lines, sizes, errors }: BundleDiscountFieldsProps) {
  const cfg: BundleDiscountConfig = form.bundleDiscountConfig ?? DEFAULT_BUNDLE_DISCOUNT
  const picked = (cfg.lines ?? []).length > 0 || (cfg.sizes ?? []).length > 0
  const [choosing, setChoosing] = useState(picked)
  const patch = (p: Partial<BundleDiscountConfig>) => setForm((f) => ({ ...f, bundleDiscountConfig: { ...(f.bundleDiscountConfig ?? DEFAULT_BUNDLE_DISCOUNT), ...p } }))
  const isFixed = cfg.kind === 'fixed'
  const showPick = choosing || picked
  return (
    <div id={PROMO_FIELD.bundleDiscount} tabIndex={-1} className="space-y-3 rounded-xl bg-paper-1 p-3">
      <p className="text-xs font-bold uppercase tracking-wider text-ink-700">Diskon per bundle</p>
      <div className="flex flex-wrap items-end gap-3">
        <span className="w-14 pb-2 text-xs font-bold text-ink-700">Diskon</span>
        <Seg label="Jenis diskon" value={cfg.kind} onChange={(kind) => patch({ kind: kind as 'percentage' | 'fixed' })} options={[{ value: 'percentage', label: 'Persen' }, { value: 'fixed', label: 'Nominal' }]} />
        <Input id={PROMO_FIELD.value} label={isFixed ? 'Potongan (Rp) *' : 'Diskon (1% – 99%) *'} type="number" min={0} value={form.value} error={errors[PROMO_FIELD.value]} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
        <span className="pb-2 text-xs text-ink-700">per bundle</span>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <span className="w-14 pt-2 text-xs font-bold text-ink-700">Berlaku</span>
        <div className="space-y-2">
        <Seg
          label="Berlaku untuk"
          value={showPick ? 'pick' : 'all'}
          onChange={(v) => {
            setChoosing(v === 'pick')
            if (v === 'all') patch({ lines: [], sizes: [] })
          }}
          options={[{ value: 'all', label: 'Semua bundle' }, { value: 'pick', label: 'Pilih' }]}
        />
        {showPick && (
          <div className="space-y-2">
            <CheckChips label="Lini" items={lines.map((l) => ({ key: l.line, label: l.label }))} value={cfg.lines ?? []} empty="Semua lini" onChange={(next) => patch({ lines: next })} />
            <CheckChips label="Ukuran" items={sizes.map((s) => ({ key: s, label: s }))} value={cfg.sizes ?? []} empty="Semua ukuran" onChange={(next) => patch({ sizes: next })} />
          </div>
        )}
        {errors[PROMO_FIELD.bundleDiscount] && <p role="alert" className="text-xs font-semibold text-danger">{errors[PROMO_FIELD.bundleDiscount]}</p>}
        </div>
      </div>
      <p className="rounded-lg border border-warn bg-warn-bg p-2 text-[11px] text-ink-900">
        Bisa digabung dengan kode promo dan penukaran poin. Bila dua Diskon Bundle berlaku pada bundle yang sama, hanya diskon terbesar yang dipakai.
      </p>
    </div>
  )
}
