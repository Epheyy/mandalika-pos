import { Button } from '../../ui/Button'
import { Field, Input } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import type { CustomerForm } from './customerForm'

interface CustomerFormSlideOverProps {
  editing: boolean
  form: CustomerForm
  setForm: (patch: Partial<CustomerForm>) => void
  /** Unsaved changes. Guarded by the screen (one question for x, Escape, Back and the sidebar), not by the panel. */
  dirty: boolean
  busy: boolean
  err: string | null
  phoneDupe: boolean
  onSave: () => void
  onClose: () => void
}

export function CustomerFormSlideOver({ editing, form, setForm, dirty, busy, err, phoneDupe, onSave, onClose }: CustomerFormSlideOverProps) {
  return (
    <SlideOver
      open
      onClose={onClose}
      dirty={false}
      title={editing ? 'Edit Pelanggan' : 'Tambah Pelanggan'}
      footer={
        <SlideOver.Footer dirty={dirty}>
          <Button variant="secondary" onClick={onClose}>Batal</Button>
          <Button loading={busy} onClick={onSave}>{busy ? 'Menyimpan...' : 'Simpan'}</Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        <Input label="Nama *" type="text" value={form.name} onChange={(e) => setForm({ name: e.target.value })} />
        <Input label="No. Telepon *" type="tel" value={form.phone} onChange={(e) => setForm({ phone: e.target.value })} />
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ email: e.target.value })} />
        {phoneDupe && (
          <p className="text-xs text-amber-600">⚠ Nomor telepon ini sudah dipakai pelanggan lain. Tetap bisa disimpan.</p>
        )}
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
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
      </div>
    </SlideOver>
  )
}
