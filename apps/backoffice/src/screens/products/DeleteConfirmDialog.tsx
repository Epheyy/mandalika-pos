import { ConfirmDialog } from '../../ui/ConfirmDialog'

interface DeleteConfirmDialogProps {
  open: boolean
  /** What is being deleted, e.g. `produk "Melati"`. */
  subject: string
  /** What happens beyond the delete itself (e.g. how many products lose their category); shown before the standing warning. */
  detail?: string
  /** A refused delete's reason (the server's 409 text), shown inside the dialog, which stays open. */
  error?: string | null
  /** A delete in flight: both buttons are disabled and the dialog cannot be dismissed. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** The delete question for a product or category. Controlled (not useConfirm) so a refusal stays on screen. */
export function DeleteConfirmDialog({ open, subject, detail, error, busy = false, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title={`Hapus ${subject}?`}
      consequence={detail ? `${detail} Data tidak dapat dikembalikan.` : 'Data tidak dapat dikembalikan.'}
      confirmLabel="Hapus"
      tone="danger"
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
