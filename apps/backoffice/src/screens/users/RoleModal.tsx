import type { CustomRole } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
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
  /** The server's refusal of the last save, shown inside the dialog. */
  error?: string | null
  onSave: () => void
  /** The role waiting for its delete answer (null = no question open). */
  delRole: CustomRole | null
  /** The server's reason a delete was refused (e.g. the role is still in use); the question stays open. */
  deleteError?: string | null
  deleting?: boolean
  onCloseDelete: () => void
  onConfirmDelete: () => void
}

function RoleModal({
  open, onClose, editingRole, roleForm, setRoleForm, busy, error, onSave, delRole, deleteError, deleting = false, onCloseDelete, onConfirmDelete,
}: RoleModalProps) {
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
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Input label="Nama Role *" type="text" value={roleForm.name} onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))} />
          <Field label="Permission">
            <PermissionPicker
              selected={roleForm.permissions}
              onToggle={(p) => setRoleForm((f) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] }))}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!delRole}
        title={`Hapus role ${delRole?.name ?? ''}?`}
        consequence="Template permission ini akan hilang. Pengguna yang sudah memakainya tidak berubah."
        confirmLabel="Hapus role"
        tone="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={onConfirmDelete}
        onCancel={onCloseDelete}
      />
    </>
  )
}

export { RoleModal }
