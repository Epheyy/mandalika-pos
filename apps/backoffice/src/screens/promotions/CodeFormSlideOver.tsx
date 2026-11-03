import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Customer, DiscountCodeInput, Promotion } from '@mandalika/api'
import { RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { generateCode } from '../../lib/csvUtils'
import { Button } from '../../ui/Button'
import { Field, Input, Select, fieldClass } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { Switch } from '../../ui/Switch'
import { CUSTOMER_PHONE_HINT, customerLookupTerm } from './customerLookupMode'
import { CODE_FIELD } from './discountCodeForm'
import type { FormProblem } from './promotionForm'
import type { EditorLoad } from './useRecordEditor'

export interface CodeFormSlideOverProps {
  editing: boolean
  load: EditorLoad
  loadError: string | null
  form: DiscountCodeInput
  setForm: Dispatch<SetStateAction<DiscountCodeInput>>
  /** Every promotion, for the "Tautkan ke promosi" choice (not just the visible page). */
  promotions: readonly Promotion[]
  /** Display-only name for form.customerId (DiscountCodeInput has no customerName field). */
  customerName: string
  /** The caller may only find customers by a full phone number (A30). */
  phoneOnly?: boolean
  onCustomerChange: (id: string | undefined, name: string) => void
  dirty: boolean
  busy: boolean
  err: string | null
  problems: readonly FormProblem[]
  saveBlocked: boolean
  onSave: () => void
  onClose: () => void
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-2.5">
      <p aria-hidden="true" className="text-sm font-bold text-gray-700">{label}</p>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

/** Customer typeahead: readers get a debounced search; a phone-only caller searches on Enter / Cari (each lookup spends the shared budget). */
function CustomerPicker({ form, customerName, phoneOnly, onCustomerChange }: Pick<CodeFormSlideOverProps, 'form' | 'customerName' | 'phoneOnly' | 'onCustomerChange'>) {
  const phone = phoneOnly ?? false
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const term = customerLookupTerm(phone, query, submitted)

  useEffect(() => {
    if (!term) return
    let ignore = false
    const run = async () => {
      try {
        const found = phone ? await api.lookupCustomerByPhone(term) : await api.lookupCustomers(term, 10)
        if (!ignore) setResults(found)
      } catch {
        if (!ignore) setResults([])
      }
    }
    const t = setTimeout(run, phone ? 0 : 250)
    return () => { clearTimeout(t); ignore = true }
  }, [term, phone])

  if (form.customerId) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-gold-200 bg-gold-50 px-3 py-2.5">
        <span className="truncate text-sm font-bold text-gray-900">{customerName || form.customerId}</span>
        <button
          type="button"
          onClick={() => onCustomerChange(undefined, '')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-lg font-bold text-gray-400 hover:bg-red-50 hover:text-red-500"
          aria-label="Hapus pelanggan terpilih"
        >×</button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (phone && e.key === 'Enter') { e.preventDefault(); setSubmitted(query) }
        }}
        placeholder={phone ? 'No. HP lengkap pelanggan…' : 'Cari nama / no. HP pelanggan…'}
        aria-label="Cari pelanggan"
        className={fieldClass}
      />
      {phone && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-gray-500">{CUSTOMER_PHONE_HINT} Tekan Enter atau Cari.</p>
          <Button variant="secondary" onClick={() => setSubmitted(query)}>Cari</Button>
        </div>
      )}
      {term && (
        <div className="max-h-44 overflow-auto rounded-lg border border-gray-200 bg-white">
          {results.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-gray-400">Tidak ada pelanggan cocok.</p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onCustomerChange(c.id, c.name); setQuery(''); setSubmitted(''); setResults([]) }}
                className="flex w-full items-center justify-between border-b border-gray-50 px-3 py-2 text-left text-sm last:border-0 hover:bg-gold-50"
              >
                <span className="font-medium text-gray-800">{c.name}</span>
                <span className="text-xs text-gray-400">{c.phone}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** The discount-code editor, a SlideOver like the promotion one (the code form had no wizard, only a modal). */
export function CodeFormSlideOver(p: CodeFormSlideOverProps) {
  const { form, setForm } = p
  const byField: Record<string, string> = Object.fromEntries(p.problems.map((e) => [e.fieldId, e.message]))
  const ready = p.load === 'ready'
  const linked = !!form.promotionId
  return (
    <SlideOver
      open
      onClose={p.onClose}
      width="md"
      dirty={false}
      title={p.editing ? 'Ubah Kode Diskon' : 'Tambah Kode Diskon'}
      errorSummary={p.problems.map((e) => ({ fieldId: e.fieldId, label: e.label }))}
      footer={
        <SlideOver.Footer dirty={p.dirty}>
          <Button variant="secondary" onClick={p.onClose}>{ready ? 'Batal' : 'Tutup'}</Button>
          {ready && <Button variant="primary" loading={p.busy} disabled={p.saveBlocked} onClick={p.onSave}>Simpan</Button>}
        </SlideOver.Footer>
      }
    >
      {p.load === 'loading' && <p className="text-sm text-ink-700">Memuat kode diskon…</p>}
      {(p.load === 'missing' || p.load === 'failed') && <p role="alert" className="text-sm text-red-600">{p.loadError}</p>}
      {ready && (
        <div className="space-y-4">
          <Field label="Kode *" htmlFor={CODE_FIELD.code} error={byField[CODE_FIELD.code]}>
            <div className="flex gap-2">
              <input
                id={CODE_FIELD.code}
                type="text"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                aria-label="Kode diskon"
                aria-invalid={byField[CODE_FIELD.code] ? true : undefined}
                className={`${fieldClass} flex-1 font-mono tracking-wider`}
              />
              <Button variant="secondary" aria-label="Buat kode acak" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setForm((f) => ({ ...f, code: generateCode() }))} />
            </div>
          </Field>
          <Select label="Tautkan ke promosi" value={form.promotionId ?? ''} onChange={(e) => setForm((f) => ({ ...f, promotionId: e.target.value || undefined }))}>
            <option value="">— Tidak ditautkan —</option>
            {p.promotions.map((promo) => <option key={promo.id} value={promo.id}>{promo.name}</option>)}
          </Select>
          <Field label="Khusus pelanggan (opsional)" hint="kosong = bisa dipakai siapa saja">
            <CustomerPicker form={form} customerName={p.customerName} phoneOnly={p.phoneOnly} onCustomerChange={p.onCustomerChange} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Select label="Tipe" value={form.type} disabled={linked} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as DiscountCodeInput['type'] }))}>
              <option value="percentage">Persentase (%)</option>
              <option value="fixed">Nominal (Rp)</option>
            </Select>
            <Input label="Nilai" type="number" value={form.value} disabled={linked} onChange={(e) => setForm((f) => ({ ...f, value: parseFloat(e.target.value) || 0 }))} />
          </div>
          {linked && <p className="-mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Tipe &amp; nilai diikuti dari promosi tertaut.</p>}
          <div className="grid grid-cols-2 gap-4">
            <Input label="Min. Beli" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: parseFloat(e.target.value) || 0 }))} />
            <Input label="Batas Pakai" type="number" value={form.usageLimit || ''} onChange={(e) => setForm((f) => ({ ...f, usageLimit: parseInt(e.target.value) || 0 }))} />
          </div>
          <Input
            label="Batas per pelanggan"
            type="number"
            min={1}
            value={form.perCustomerLimit ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, perCustomerLimit: e.target.value === '' ? undefined : Number(e.target.value) }))}
            hint="kosong = tak terbatas"
          />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
            <Input label="Berakhir" type="date" value={form.endDate || ''} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
          </div>
          <SwitchRow label="Bisa dikombinasikan dengan promo/kode lain" checked={form.combinable ?? false} onChange={(combinable) => setForm((f) => ({ ...f, combinable }))} />
          <SwitchRow label="Kode Aktif" checked={form.isActive} onChange={(isActive) => setForm((f) => ({ ...f, isActive }))} />
          {p.err && <p role="alert" className="text-sm text-red-600">{p.err}</p>}
        </div>
      )}
    </SlideOver>
  )
}
