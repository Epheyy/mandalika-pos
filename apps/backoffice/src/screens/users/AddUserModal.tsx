import type { Outlet } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Input, Select, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { PermissionPicker } from './PermissionPicker'
import { ROLE } from '../../lib/labels/role'

type Role = 'admin' | 'manager' | 'cashier'
const ROLE_LABEL: Record<Role, string> = { admin: ROLE.admin.label, manager: ROLE.manager.label, cashier: ROLE.cashier.label }

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
  onSave: () => void
}

function AddUserModal({ open, onClose, nf, setNf, busy, outlets, onSave }: AddUserModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tambah Pengguna"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button className="flex-1" loading={busy} onClick={onSave}>{busy ? 'Menambahkan...' : 'Tambah'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {[
          { k: 'displayName' as const, label: 'Nama *', type: 'text' },
          { k: 'email' as const, label: 'Email *', type: 'email' },
          { k: 'password' as const, label: 'Kata Sandi *', type: 'password' },
        ].map(({ k, label, type }) => (
          <Input key={k} label={label} type={type} value={nf[k]} onChange={(e) => setNf((f) => ({ ...f, [k]: e.target.value }))} />
        ))}
        <Field label="Role">
          <div className="grid grid-cols-3 gap-2">
            {(['admin', 'manager', 'cashier'] as Role[]).map((r) => (
              <button type="button" key={r} onClick={() => setNf((f) => ({ ...f, role: r }))} className={`py-2 text-sm font-bold rounded-xl border-2 ${nf.role === r ? 'border-gold-600 bg-gold-50 text-gold-700' : 'border-gray-200 text-gray-500'}`}>{ROLE_LABEL[r]}</button>
            ))}
          </div>
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
          <p className="text-[11px] text-amber-600 -mt-3">Kasir sebaiknya ditempatkan di satu outlet.</p>
        )}
        {nf.role !== 'admin' && (
          <Field label="Permission">
            <PermissionPicker
              selected={nf.permissions}
              onToggle={(p) => setNf((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))}
              compact
            />
          </Field>
        )}
      </div>
    </Modal>
  )
}

export type { NewUserForm }
export { AddUserModal }
