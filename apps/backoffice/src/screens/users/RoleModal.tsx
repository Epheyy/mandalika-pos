import type { CustomRole } from '@mandalika/api'
import { Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input, Field } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import { PermissionPicker } from './PermissionPicker'

type RoleForm = { name: string; permissions: string[] }

interface RoleModalProps {
  open: boolean
  onClose: () => void
  editingRole: CustomRole | null
  roleForm: RoleForm
  setRoleForm: React.Dispatch<React.SetStateAction<RoleForm>>
  busy: boolean
  onSave: () => void
  delRole: string | null
  onCloseDelete: () => void
  onConfirmDelete: () => void
}

function RoleModal({ open, onClose, editingRole, roleForm, setRoleForm, busy, onSave, delRole, onCloseDelete, onConfirmDelete }: RoleModalProps) {
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={editingRole ? 'Edit Role' : 'Buat Role Kustom'}
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
            <Button className="flex-1" loading={busy} onClick={onSave}>Simpan</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Nama Role *" type="text" value={roleForm.name} onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))} />
          <Field label="Permission">
            <PermissionPicker
              selected={roleForm.permissions}
              onToggle={(p) => setRoleForm((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!delRole}
        onClose={onCloseDelete}
        size="sm"
        footer={
          <>
            <Button variant="secondary" className="flex-1" onClick={onCloseDelete}>Batal</Button>
            <Button variant="danger" className="flex-1" onClick={onConfirmDelete}>Ya, Hapus</Button>
          </>
        }
      >
        <div className="text-center">
          <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
          <h3 className="text-xl font-black text-gray-900 mb-2">Hapus Role?</h3>
          <p className="text-sm text-gray-400">Template permission akan hilang.</p>
        </div>
      </Modal>
    </>
  )
}

export { RoleModal }
