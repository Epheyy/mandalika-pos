import { useId, type ReactNode } from 'react'

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
  closeLabel?: string
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
  center: 'fixed inset-0 bg-black/40 flex items-center justify-center p-4',
  side: 'fixed inset-0 flex justify-end',
  full: 'fixed inset-0 bg-gray-50',
}

const PANEL_CLASSES: Record<SheetVariant, string> = {
  center: 'bg-white rounded-2xl w-full shadow-xl',
  side: 'bg-white h-full w-full',
  full: 'w-full h-full',
}

const BACKDROP_CLASSES: Record<SheetVariant, string> = {
  center: 'absolute inset-0 cursor-default',
  side: 'absolute inset-0 bg-black/30',
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
  testId,
  children,
}: Props) {
  const titleId = useId()
  if (!open) return null
  const width = maxWidth ?? (variant === 'side' ? 'max-w-lg' : variant === 'center' ? 'max-w-md' : '')
  // `relative` is only needed to stack the panel above the absolute backdrop button.
  const hasBackdrop = onClose !== undefined && variant !== 'full'
  const panelClasses = [PANEL_CLASSES[variant], width, hasBackdrop || variant === 'side' ? 'relative' : '', panelClassName]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={`${OVERLAY_CLASSES[variant]} ${Z_CLASSES[z]}`} data-testid={testId}>
      {hasBackdrop && (
        <button type="button" aria-label={closeLabel} tabIndex={-1} className={BACKDROP_CLASSES[variant]} onClick={onClose} />
      )}
      <div role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} className={panelClasses}>
        {title ? (
          <h2 id={titleId} className="font-bold text-gray-900">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>
  )
}
