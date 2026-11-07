import type { ReactNode } from 'react'
import { Button } from './Button'
import { Sheet } from './Sheet'

type Props = {
  open: boolean
  message: string
  confirmLabel: string
  /** 'danger' for destructive confirms (Kosongkan); 'primary' otherwise. */
  tone?: 'danger' | 'primary'
  cancelLabel?: string
  /** Accessible name of the backdrop tap target; defaults to cancelLabel. */
  backdropLabel?: string
  /** Optional heading above the message (W6-10). */
  title?: ReactNode
  /** Optional extra body (e.g. a totals block) between the message and the buttons. */
  children?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

/** Two-button confirm in a centre Sheet above every other surface (z-70). Backdrop tap = Batal. */
export function ConfirmDialog({ open, message, confirmLabel, tone = 'primary', cancelLabel = 'Batal', backdropLabel, title, children, onConfirm, onCancel }: Props) {
  return (
    <Sheet open={open} onClose={onCancel} variant="center" z={70} maxWidth="max-w-sm" closeLabel={backdropLabel ?? cancelLabel} panelClassName="p-5">
      {title && <h2 className="mb-2 text-lg font-bold text-ink-900">{title}</h2>}
      <p role="alert" className="text-[0.9375rem] text-ink-900">{message}</p>
      {children}
      <div className="mt-5 flex gap-2">
        <Button variant="secondary" onClick={onCancel} className="flex-1">
          {cancelLabel}
        </Button>
        <Button variant={tone} onClick={onConfirm} className="flex-1">
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  )
}
