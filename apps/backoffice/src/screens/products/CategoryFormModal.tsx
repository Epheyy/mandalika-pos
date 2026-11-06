import type { Category } from '@mandalika/api'
import { Button } from '../../ui/Button'
import { Input, Textarea } from '../../ui/Field'
import { Modal } from '../../ui/Modal'
import type { CategoryForm } from './useCategories'

interface CategoryFormModalProps {
  open: boolean
  editingCat: Category | null
  catForm: CategoryForm
  setCatForm: React.Dispatch<React.SetStateAction<CategoryForm>>
  busy: boolean
  /** This form's own error (validation or a refused save). */
  error: string | null
  onSave: () => void
  onClose: () => void
}

export function CategoryFormModal({ open, editingCat, catForm, setCatForm, busy, error, onSave, onClose }: CategoryFormModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={editingCat ? 'Ubah Kategori' : 'Tambah Kategori'}
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button variant="primary" className="flex-1" loading={busy} onClick={onSave}>Simpan</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nama *" type="text" value={catForm.name} error={error && !catForm.name.trim() ? error : undefined} onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))} />
        <Textarea label="Deskripsi" value={catForm.description} onChange={(e) => setCatForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
        {error && catForm.name.trim() && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
