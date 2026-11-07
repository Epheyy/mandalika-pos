import type { Outlet } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Input, Select, Field } from '../../ui/Field'
import { SlideOver } from '../../ui/SlideOver'
import { PermissionPicker } from './PermissionPicker'
import { RolePicker } from './RolePicker'
import type { Role } from './roles'

type NewUserForm = {
  displayName: string
  email: string
  password: string
  role: Role
  outletId: string
  permissions: string[]
}

interface AddUserModalProps {
  open: boolean
  onClose: () => void
  nf: NewUserForm
  setNf: React.Dispatch<React.SetStateAction<NewUserForm>>
  busy: boolean
  outlets: Outlet[]
  /** The server's refusal of the last save, shown inside the dialog. */
  error?: string | null
  onSave: () => void
}

function AddUserModal({ open, onClose, nf, setNf, busy, outlets, error, onSave }: AddUserModalProps) {
  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Tambah Pengguna"
      footer={
        <SlideOver.Footer>
          <Button variant="secondary" onClick={onClose}>Batal</Button>
          <Button loading={busy} onClick={onSave}>{busy ? 'Menambahkan...' : 'Tambah'}</Button>
        </SlideOver.Footer>
      }
    >
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {[
          { k: 'displayName' as const, label: 'Nama *', type: 'text', autoComplete: 'off' },
          { k: 'email' as const, label: 'Email *', type: 'email', autoComplete: 'off' },
          { k: 'password' as const, label: 'Kata Sandi *', type: 'password', autoComplete: 'new-password' },
        ].map(({ k, label, type, autoComplete }) => (
          <Input key={k} label={label} type={type} autoComplete={autoComplete} value={nf[k]} onChange={(e) => setNf((f) => ({ ...f, [k]: e.target.value }))} />
        ))}
        <Field label="Role">
          <RolePicker value={nf.role} onChange={(r) => setNf((f) => ({ ...f, role: r }))} />
        </Field>
        <Select
          label="Outlet"
          value={nf.outletId}
          onChange={(e) => setNf((f) => ({ ...f, outletId: e.target.value }))}
        >
          <option value="">Semua Outlet (tanpa pembatasan)</option>
          {outlets.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </Select>
        {nf.role === 'cashier' && !nf.outletId && (
          <p className="text-[11px] text-warn-strong -mt-3">Kasir sebaiknya ditempatkan di satu outlet.</p>
        )}
        {nf.role !== 'admin' && (
          <Field label="Izin akses">
            <PermissionPicker
              selected={nf.permissions}
              onToggle={(p) => setNf((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))}
              compact
            />
          </Field>
        )}
      </div>
    </SlideOver>
  )
}

export type { NewUserForm }
export { AddUserModal }
