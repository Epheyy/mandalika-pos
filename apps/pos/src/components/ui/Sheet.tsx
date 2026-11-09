import { useId, useRef, type ReactNode } from 'react'
import { useSheetLayer } from './sheetLayers'

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
  /** Accessible name of the backdrop (pointer-only when `header` is on). The header control is named by its visible text instead. */
  closeLabel?: string
  /** Visible label of the header's back control (W2-02); its accessible name is this same text. */
  backLabel?: string
  /**
   * Render the standard sheet header: ONE "‹ Kembali" control top-left and the title centred, as on every Kaca mock
   * (W2-02, M-12). Opt-in so existing consumers, which still draw their own header, never show two controls; a screen
   * slice turns it on and deletes its own. Needs `onClose` (without it there is nothing to close) and is ignored on
   * the `full` variant.
   */
  header?: boolean
  /**
   * Accessible name when no visible `title` is passed (the dialog then has no visible h2). Ignored when `title` is set.
   * Lets a dialog that draws its own heading still be announced by name.
   */
  ariaLabel?: string
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
  full: 'fixed inset-0 bg-paper-0',
}

// End above the soft keyboard (keyboardInset.ts sets --kb; 0 when closed). h-full panels shrink to what is left.
const OVERLAY_STYLE = { bottom: 'var(--kb, 0px)' } as const

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
  backLabel = 'Kembali',
  header = false,
  ariaLabel,
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
    <div className={`${OVERLAY_CLASSES[variant]} ${Z_CLASSES[z]}`} style={OVERLAY_STYLE} data-testid={testId}>
      {hasBackdrop && (
        // With the header's close control present the backdrop is a pointer-only extra: hiding it keeps one close control in the tree.
        <button
          type="button"
          aria-label={closeLabel}
          aria-hidden={hasHeader || undefined}
          tabIndex={-1}
          className={BACKDROP_CLASSES[variant]}
          onClick={onClose}
        />
      )}
      <SheetPanel
        titleId={title ? titleId : undefined}
        ariaLabel={title ? undefined : ariaLabel}
        className={panelClasses}
        onEscape={onClose}
      >
        {hasHeader ? (
          <div className="grid flex-shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 py-1">
            {/* No aria-label: the visible text is the accessible name (label in name, WCAG 2.5.3). */}
            <button
              type="button"
              onClick={onClose}
              className="press inline-flex min-h-11 items-center gap-1 justify-self-start rounded-control pl-2 pr-3 text-sm font-semibold text-brand-strong active:bg-paper-1"
            >
              <span aria-hidden="true" className="text-xl leading-none">‹</span>
              {backLabel}
            </button>
            {title ? (
              <h2 id={titleId} className="break-words text-center text-lg font-bold text-ink-900">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {/* Invisible twin of the back control: keeps the title centred whatever the label length. */}
            <span aria-hidden="true" className="invisible inline-flex min-h-11 items-center gap-1 pl-2 pr-3 text-sm font-semibold">
              <span className="text-xl leading-none">‹</span>
              {backLabel}
            </span>
          </div>
        ) : title ? (
          <h2 id={titleId} className="font-bold text-ink-900">
            {title}
          </h2>
        ) : null}
        {children}
      </SheetPanel>
    </div>
  )
}

/** The dialog panel. Holds the hooks (layer registration, focus trap) so `Sheet` itself stays a plain function. */
function SheetPanel({
  titleId,
  ariaLabel,
  className,
  onEscape,
  children,
}: {
  titleId?: string
  ariaLabel?: string
  className: string
  onEscape?: () => void
  children: ReactNode
}) {
  const layerId = useId()
  const panel = useRef<HTMLDivElement>(null)
  useSheetLayer(layerId, panel, onEscape)
  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`${className} focus:outline-none`}
    >
      {children}
    </div>
  )
}
