import { Button } from '../../ui/Button'
import { Field, Input } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { CUSTOMER_FIELD_ID, type CustomerForm, type CustomerFormError } from './customerForm'

interface CustomerFormSlideOverProps {
  editing: boolean
  form: CustomerForm
  setForm: (patch: Partial<CustomerForm>) => void
  /** Unsaved changes. Guarded by the screen (one question for x, Escape, Back and the sidebar), not by the panel. */
  dirty: boolean
  busy: boolean
  /** Server-side failure of the last save. */
  err: string | null
  /** Field errors; shown only once a save was attempted. */
  errors: readonly CustomerFormError[]
  /** Name of another customer who already uses this phone, or null. */
  phoneDupeName: string | null
  onSave: () => void
  onClose: () => void
}

export function CustomerFormSlideOver({ editing, form, setForm, dirty, busy, err, errors, phoneDupeName, onSave, onClose }: CustomerFormSlideOverProps) {
  const byField: Record<string, string> = Object.fromEntries(errors.map((e) => [e.fieldId, e.message]))
  return (
    <SlideOver
      open
      onClose={onClose}
      dirty={false}
      title={editing ? 'Edit Pelanggan' : 'Tambah Pelanggan'}
      errorSummary={errors.map((e) => ({ fieldId: e.fieldId, label: e.label }))}
      footer={
        <SlideOver.Footer dirty={dirty}>
          <Button variant="secondary" onClick={onClose}>Batal</Button>
          <Button loading={busy} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <Input id={CUSTOMER_FIELD_ID.name} label="Nama *" type="text" value={form.name} error={byField[CUSTOMER_FIELD_ID.name]} onChange={(e) => setForm({ name: e.target.value })} />
        <Input id={CUSTOMER_FIELD_ID.phone} label="No. Telepon *" type="tel" value={form.phone} error={byField[CUSTOMER_FIELD_ID.phone]} hint="Nomor Indonesia (0812… / +62…) atau internasional (+65…)" onChange={(e) => setForm({ phone: e.target.value })} />
        {phoneDupeName && !byField[CUSTOMER_FIELD_ID.phone] && (
          <p className="text-xs text-amber-600">⚠ Nomor ini sudah dipakai oleh {phoneDupeName}. Tetap bisa disimpan; akan masuk antrean Duplikat.</p>
        )}
        <Input id={CUSTOMER_FIELD_ID.email} label="Email" type="email" value={form.email} error={byField[CUSTOMER_FIELD_ID.email]} onChange={(e) => setForm({ email: e.target.value })} />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Ulang Tahun" type="date" value={form.birthday} onChange={(e) => setForm({ birthday: e.target.value })} />
          <Input label="Hari Jadi" type="date" value={form.anniversary} onChange={(e) => setForm({ anniversary: e.target.value })} />
        </div>
        <Field label="Catatan">
          <textarea
            aria-label="Catatan"
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/40 focus:border-gold-400"
            rows={3}
            value={form.notes}
            onChange={(e) => setForm({ notes: e.target.value })}
          />
        </Field>
      </div>
    </SlideOver>
  )
}
