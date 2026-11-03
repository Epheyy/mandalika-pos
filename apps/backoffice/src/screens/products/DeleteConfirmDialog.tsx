import { ConfirmDialog } from '../../ui/ConfirmDialog'

interface DeleteConfirmDialogProps {
  open: boolean
  /** What is being deleted, e.g. `produk "Melati"`. */
  subject: string
  /** A refused delete's reason (the server's 409 text), shown inside the dialog, which stays open. */
  error?: string | null
  /** A delete in flight: both buttons are disabled and the dialog cannot be dismissed. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** The delete question for a product or category. Controlled (not useConfirm) so a refusal stays on screen. */
export function DeleteConfirmDialog({ open, subject, error, busy = false, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title={`Hapus ${subject}?`}
      consequence="Data tidak dapat dikembalikan."
      confirmLabel="Hapus"
      tone="danger"
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
