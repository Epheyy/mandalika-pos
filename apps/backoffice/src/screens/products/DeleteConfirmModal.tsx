import { Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Modal } from '../../ui/Modal'

interface DeleteConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title?: string
  message?: string
}

export function DeleteConfirmModal({
  open, onClose, onConfirm,
  title = 'Konfirmasi Hapus',
  message = 'Data tidak dapat dikembalikan.',
}: DeleteConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>Batal</Button>
          <Button variant="danger" className="flex-1" onClick={onConfirm}>Ya, Hapus</Button>
        </>
      }
    >
      <div className="text-center">
        <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4"><Trash2 className="w-7 h-7 text-red-500" /></div>
        <h3 className="text-xl font-black text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-400">{message}</p>
      </div>
    </Modal>
  )
}
