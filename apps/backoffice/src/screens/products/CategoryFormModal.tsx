import type { Category } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Input, Textarea } from '../../ui/Field'
import { Modal } from '../../ui/Modal'

interface CategoryFormModalProps {
  open: boolean
  editingCat: Category | null
  catForm: { name: string; description: string }
  setCatForm: React.Dispatch<React.SetStateAction<{ name: string; description: string }>>
  busy: boolean
  onSave: () => void
  onClose: () => void
}

export function CategoryFormModal({ open, editingCat, catForm, setCatForm, busy, onSave, onClose }: CategoryFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={editingCat ? 'Edit Kategori' : 'Tambah Kategori'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button variant="primary" className="flex-1" loading={busy} onClick={onSave}>Simpan</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nama *" type="text" value={catForm.name} onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))} />
        <Textarea label="Deskripsi" value={catForm.description} onChange={(e) => setCatForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
      </div>
    </Modal>
  )
}
