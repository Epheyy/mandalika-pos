import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { Outlet, Product, PromotionInput } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Field, Input, Textarea } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { Switch } from '../../ui/Switch'
import { cn } from '../../ui/cn'
import { OutletChips } from './OutletChips'
import { PromoTypeFields } from './PromoTypeFields'
import { VariantKeyPicker } from './VariantKeyPicker'
import { PROMO_FIELD, type FormProblem } from './promotionForm'
import type { EditorLoad } from './useRecordEditor'

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']

export interface PromoFormSlideOverProps {
  editing: boolean
  load: EditorLoad
  loadError: string | null
  form: PromotionInput
  setForm: Dispatch<SetStateAction<PromotionInput>>
  products: Product[]
  productsState: 'loading' | 'ready' | 'failed'
  outlets: Outlet[]
  /** Until the outlet list is known, chips would show every real outlet as unknown: they wait for it. */
  outletsState: 'loading' | 'ready' | 'failed'
  /** Unsaved changes, shown as a note in the footer (the screen asks about them, not the panel). */
  dirty: boolean
  busy: boolean
  /** A refused save (server message). */
  err: string | null
  /** The problems to show now. */
  problems: readonly FormProblem[]
  /** Any problem at all: Save stays off until the form is valid. */
  saveBlocked: boolean
  onSave: () => void
  /** Closes the editor; the caller asks about unsaved changes first. */
  onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-4 border-t border-paper-2 pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-black uppercase tracking-widest text-ink-700">{title}</h3>
      {children}
    </section>
  )
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-paper-2 px-3 py-2.5">
      <div>
        <p aria-hidden="true" className="text-sm font-bold text-ink-700">{label}</p>
        {hint && <p className="text-xs text-ink-700">{hint}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

/** The promotion editor: one scrolling panel with sections instead of the old three-step wizard (D-80). */
export function PromoFormSlideOver(p: PromoFormSlideOverProps) {
  const { form, setForm } = p
  const byField: Record<string, string> = Object.fromEntries(p.problems.map((e) => [e.fieldId, e.message]))
  const ready = p.load === 'ready'
  const days = form.activeDays ?? []
  const hasHours = !!form.activeFromHour || !!form.activeToHour
  const showVariants = form.type !== 'buy_x_get_y' && form.type !== 'tiered' && form.type !== 'bundle'
  const toggleDay = (d: number) => setForm((f) => ({ ...f, activeDays: (f.activeDays ?? []).includes(d) ? (f.activeDays ?? []).filter((x) => x !== d) : [...(f.activeDays ?? []), d] }))

  return (
    <SlideOver
      open
      onClose={p.onClose}
      width="lg"
      // Unsaved changes are guarded by the screen (one question for ×, Escape, Back and the sidebar), not by the panel.
      dirty={false}
      title={p.editing ? 'Ubah Promosi' : 'Tambah Promosi'}
      errorSummary={p.problems.map((e) => ({ fieldId: e.fieldId, label: e.label }))}
      footer={
        <SlideOver.Footer dirty={p.dirty}>
          <Button variant="secondary" disabled={p.busy} onClick={p.onClose}>{ready ? 'Batal' : 'Tutup'}</Button>
          {ready && (
            <Button variant="primary" loading={p.busy} disabled={p.saveBlocked} title={p.saveBlocked ? 'Lengkapi isian yang wajib atau perbaiki isian yang salah dulu.' : undefined} onClick={p.onSave}>Simpan</Button>
          )}
        </SlideOver.Footer>
      }
    >
      {p.load === 'loading' && <p className="text-sm text-ink-700">Memuat promosi…</p>}
      {(p.load === 'missing' || p.load === 'failed') && <p role="alert" className="text-sm text-danger">{p.loadError}</p>}
      {ready && (
        <div className="space-y-6">
          <Section title="Umum">
            <Input id={PROMO_FIELD.name} label="Nama Promosi *" type="text" value={form.name} error={byField[PROMO_FIELD.name]} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Textarea label="Deskripsi" value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
            <SwitchRow label="Promosi Aktif" hint="Tablet memakainya setelah sinkron berikutnya." checked={form.isActive} onChange={(isActive) => setForm((f) => ({ ...f, isActive }))} />
          </Section>

          <Section title="Jenis dan nilai">
            <PromoTypeFields form={form} setForm={setForm} products={p.products} errors={byField} />
            {p.productsState === 'loading' && <p className="text-xs text-ink-700">Memuat daftar produk…</p>}
            {p.productsState === 'failed' && <p role="alert" className="text-xs font-semibold text-danger">Daftar produk gagal dimuat; pilihan produk kosong. Tutup dan buka lagi untuk mencoba ulang.</p>}
          </Section>

          <Section title="Periode dan jadwal">
            <div className="grid grid-cols-2 gap-4">
              <Input label="Mulai" type="date" value={form.startDate || ''} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
              <Input id={PROMO_FIELD.endDate} label="Berakhir" type="date" value={form.endDate || ''} error={byField[PROMO_FIELD.endDate]} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} />
            </div>
            <Field label="Hari aktif" hint={days.length === 0 ? 'Semua hari.' : undefined}>
              <div role="group" aria-label="Hari aktif" className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(i)}
                    onClick={() => toggleDay(i)}
                    className={cn('h-10 rounded-full border px-4 text-[13px] font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong', days.includes(i) ? 'border-brand-strong bg-brand-strong text-on-brand' : 'border-paper-2 bg-white text-ink-700 hover:bg-paper-1')}
                  >{d}</button>
                ))}
              </div>
            </Field>
            <Field label="Jam aktif" error={byField[PROMO_FIELD.hours]}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-bold text-ink-900">{hasHours ? `${form.activeFromHour || '—'} sampai ${form.activeToHour || '—'}` : 'Sepanjang hari'}</span>
                {hasHours && (
                  <Button variant="secondary" size="sm" onClick={() => setForm((f) => ({ ...f, activeFromHour: '', activeToHour: '' }))}>Sepanjang hari</Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Input id={PROMO_FIELD.hours} label="Dari" type="time" value={form.activeFromHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeFromHour: e.target.value }))} />
                <Input label="Sampai" type="time" value={form.activeToHour || ''} onChange={(e) => setForm((f) => ({ ...f, activeToHour: e.target.value }))} />
              </div>
            </Field>
          </Section>

          <Section title="Lokasi dan ketentuan">
            <Field label="Outlet" hint="Semua outlet bila tidak ada yang dipilih.">
              {p.outletsState === 'ready' && <OutletChips outlets={p.outlets} value={form.outletIds ?? []} onChange={(outletIds) => setForm((f) => ({ ...f, outletIds }))} />}
              {p.outletsState === 'loading' && <p className="text-xs text-ink-700">Memuat daftar outlet…</p>}
              {p.outletsState === 'failed' && <p role="alert" className="text-xs font-semibold text-danger">Daftar outlet gagal dimuat. Outlet promosi ini tidak diubah; tutup dan buka lagi untuk memilih outlet.</p>}
            </Field>
            <Input label="Minimum Pembelian (Rp)" type="number" value={form.minPurchase || ''} onChange={(e) => setForm((f) => ({ ...f, minPurchase: e.target.value === '' ? null : parseFloat(e.target.value) || 0 }))} />
            <SwitchRow label="Bisa dikombinasikan dengan promosi lain" checked={form.combinable ?? false} onChange={(combinable) => setForm((f) => ({ ...f, combinable }))} />
            <SwitchRow label="Hanya via kode" hint="Disembunyikan dari panel kasir." checked={form.codeOnly ?? false} onChange={(codeOnly) => setForm((f) => ({ ...f, codeOnly, autoApply: codeOnly ? false : f.autoApply }))} />
            <div id={PROMO_FIELD.autoApply} tabIndex={-1}>
              <SwitchRow label="Terapkan otomatis" hint="Masuk ke keranjang kasir sendiri saat syaratnya terpenuhi; kasir tetap bisa menghapusnya. Tidak bisa digabung dengan Hanya via kode." checked={form.autoApply ?? false} onChange={(autoApply) => setForm((f) => ({ ...f, autoApply, codeOnly: autoApply ? false : f.codeOnly }))} />
              {byField[PROMO_FIELD.autoApply] && <p role="alert" className="mt-1 text-xs font-semibold text-danger">{byField[PROMO_FIELD.autoApply]}</p>}
            </div>
            {showVariants && (
              <div id={PROMO_FIELD.products} tabIndex={-1}>
                <Field label="Varian Spesifik (opsional)" error={byField[PROMO_FIELD.products]}>
                  <VariantKeyPicker products={p.products} value={form.applicableVariantKeys ?? []} onChange={(applicableVariantKeys) => setForm((f) => ({ ...f, applicableVariantKeys }))} />
                </Field>
              </div>
            )}
          </Section>

          {p.err && <p role="alert" className="text-sm text-danger">{p.err}</p>}
        </div>
      )}
    </SlideOver>
  )
}
