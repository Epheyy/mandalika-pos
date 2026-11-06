import { useId, type ReactNode } from 'react'
import { IconClose } from './icons'

export type SheetVariant = 'center' | 'side' | 'full'
export type SheetZ = 40 | 50 | 60 | 70

type Props = {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  variant: SheetVariant
  z?: SheetZ
  /** Tailwind max-width class; defaults to max-w-md (center) / max-w-lg (side). */
  maxWidth?: string
  panelClassName?: string
  /** Accessible name of the close control and the backdrop; frozen at "Tutup" so scenarios keep finding it. */
  closeLabel?: string
  /**
   * Render the standard sheet header: the title and ONE close control, top-right (M-12). Opt-in so existing consumers,
   * which still draw their own header, never show two controls; a screen slice turns it on and deletes its own.
   * Needs `onClose` (without it there is nothing to close) and is ignored on the `full` variant.
   */
  header?: boolean
  /** Optional data-testid on the overlay element. */
  testId?: string
  children?: ReactNode
}

// Static lookup so Tailwind can see every z class as a whole string.
const Z_CLASSES: Record<SheetZ, string> = {
  40: 'z-40',
  50: 'z-50',
  60: 'z-[60]',
  70: 'z-[70]',
}

const OVERLAY_CLASSES: Record<SheetVariant, string> = {
  center: 'fixed inset-0 bg-ink-900/40 flex items-center justify-center p-4',
  side: 'fixed inset-0 flex justify-end',
  full: 'fixed inset-0 bg-gray-50',
}

const PANEL_CLASSES: Record<SheetVariant, string> = {
  center: 'surface-solid rounded-panel w-full',
  side: 'surface-solid rounded-l-panel h-full w-full',
  full: 'w-full h-full',
}

const BACKDROP_CLASSES: Record<SheetVariant, string> = {
  center: 'absolute inset-0 cursor-default',
  side: 'absolute inset-0 bg-ink-900/30',
  full: '',
}

export function Sheet({
  open,
  onClose,
  title,
  variant,
  z = 50,
  maxWidth,
  panelClassName = '',
  closeLabel = 'Tutup',
  header = false,
  testId,
  children,
}: Props) {
  const titleId = useId()
  if (!open) return null
  const width = maxWidth ?? (variant === 'side' ? 'max-w-lg' : variant === 'center' ? 'max-w-md' : '')
  // `relative` is only needed to stack the panel above the absolute backdrop button.
  const hasBackdrop = onClose !== undefined && variant !== 'full'
  const hasHeader = header && onClose !== undefined && variant !== 'full'
  const panelClasses = [PANEL_CLASSES[variant], width, hasBackdrop || variant === 'side' ? 'relative' : '', panelClassName]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={`${OVERLAY_CLASSES[variant]} ${Z_CLASSES[z]}`} data-testid={testId}>
      {hasBackdrop && (
        // With the header's close control present the backdrop is a pointer-only extra: hiding it keeps one "Tutup" in the tree.
        <button
          type="button"
          aria-label={closeLabel}
          aria-hidden={hasHeader || undefined}
          tabIndex={-1}
          className={BACKDROP_CLASSES[variant]}
          onClick={onClose}
        />
      )}
      <div role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} className={panelClasses}>
        {hasHeader ? (
          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-paper-2 py-1 pl-5 pr-2">
            {title ? (
              <h2 id={titleId} className="text-lg font-bold text-ink-900">
                {title}
              </h2>
            ) : (
              <span />
            )}
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="press inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control text-ink-700 active:bg-paper-1"
            >
              <IconClose size={18} />
            </button>
          </div>
        ) : title ? (
          <h2 id={titleId} className="font-bold text-gray-900">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>
  )
}
