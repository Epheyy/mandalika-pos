import { useId, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'
import { ConfirmDialog } from './ConfirmDialog'
import { useFocusTrap } from './focus'
import { useOverlayLayer } from './overlayStack'

type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

const MAX: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  /** Action row pinned to the bottom (e.g. Cancel / Save buttons). */
  footer?: ReactNode
  size?: Size
  /** Pad the body (default true). Set false for full-bleed list bodies. */
  padded?: boolean
  children: ReactNode
}

/** Centered overlay dialog. Closing via the backdrop or the × asks to confirm
 *  when the body has unsaved edits (any input changed since it opened). Explicit
 *  footer buttons (Batal/Simpan) are the caller's responsibility. */
export function Modal({ open, ...rest }: ModalProps) {
  // Mount the body only while open, so the dirty flag and confirm-state reset
  // naturally on each open (fresh mount) — no open-change effect needed.
  if (!open) return null
  return <ModalBody {...rest} />
}

function ModalBody({
  onClose,
  title,
  subtitle,
  footer,
  size = 'md',
  padded = true,
  children,
}: Omit<ModalProps, 'open'>) {
  const dirty = useRef(false)
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)

  // Escape only reaches the top overlay, so a SlideOver or ConfirmDialog opened over this modal keeps it open.
  const layer = useOverlayLayer(true, () => {
    if (dirty.current) setConfirming(true)
    else onClose()
  })
  // Focus goes in on open, Tab wraps inside, and focus returns to the opener on close.
  useFocusTrap(true, root, undefined, layer)

  const requestClose = () => {
    if (dirty.current) setConfirming(true)
    else onClose()
  }
  const discard = () => {
    dirty.current = false
    setConfirming(false)
    onClose()
  }

  // z-50 is OVERLAY_Z.modal; scenarios find the modal by this class, so keep it literal.
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : 'Dialog'}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Tutup"
        tabIndex={-1}
        className="absolute inset-0 bg-ink-900/40"
        onClick={requestClose}
      />
      <div
        className={cn(
          'surface-solid relative rounded-3xl w-full max-h-[90vh] flex flex-col',
          MAX[size],
        )}
        onChangeCapture={() => {
          dirty.current = true
        }}
      >
        {(title || subtitle) && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-paper-2 flex-shrink-0">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-xl font-black text-ink-900 truncate">{title}</h2>}
              {subtitle && <p className="text-sm text-ink-700 truncate">{subtitle}</p>}
            </div>
            <button type="button"
              onClick={requestClose}
              className="p-2 hover:bg-paper-1 rounded-xl flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
              aria-label="Tutup"
            >
              <X className="w-5 h-5 text-ink-700" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className={cn('overflow-y-auto flex-1', padded && 'p-6')}>{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-paper-2 flex gap-3 flex-shrink-0">{footer}</div>
        )}
      </div>

      {/* The shared ConfirmDialog is its own overlay layer: focus moves into it, Tab stays inside, Escape returns to the form. */}
      <ConfirmDialog
        open={confirming}
        title="Buang perubahan?"
        consequence="Perubahan yang belum disimpan akan hilang."
        confirmLabel="Buang"
        cancelLabel="Lanjut Edit"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={discard}
      />
    </div>
  )
}
