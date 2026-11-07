import { useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import { useFocusTrap } from './focus'
import { OVERLAY_Z, useOverlayLayer } from './overlayStack'

export interface SlideOverProps {
  open: boolean
  /** Called after the dirty guard (if any) has been answered "buang". */
  onClose: () => void
  /** The h2; exact text (scenarios query the heading by name). */
  title: string
  /** Outside the h2. */
  subtitle?: ReactNode
  /** 560 | 720 px. */
  width?: 'md' | 'lg'
  /** Explicit unsaved-changes flag. When omitted, any input change since opening counts. */
  dirty?: boolean
  /** Top alert listing field errors; each item focuses its field by id. */
  errorSummary?: readonly { fieldId: string; label: string }[]
  /** Heading of that alert; default "{n} kolom perlu diperbaiki:". */
  errorSummaryTitle?: string
  /** Sticky footer, usually <SlideOver.Footer>. */
  footer?: ReactNode
  children: ReactNode
}

const WIDTH_PX = { md: 560, lg: 720 } as const

/** Right-side panel with its own heading. aria-modal dialog, focus trap, focus returns to the opener,
 *  Escape closes only when it is the top overlay. Renders in place (no portal). */
export function SlideOver({ open, ...rest }: SlideOverProps) {
  // Mounted only while open so the dirty heuristic and the guard reset on every open.
  if (!open) return null
  return <SlideOverBody {...rest} />
}

function SlideOverBody({
  onClose,
  title,
  subtitle,
  width = 'md',
  dirty,
  errorSummary,
  errorSummaryTitle,
  footer,
  children,
}: Omit<SlideOverProps, 'open'>) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const touched = useRef(false)
  const [confirming, setConfirming] = useState(false)

  const isDirty = () => (dirty !== undefined ? dirty : touched.current)
  const requestClose = () => (isDirty() ? setConfirming(true) : onClose())

  // While the guard is up it is the top layer, so Escape reaches it and not this panel.
  const layer = useOverlayLayer(true, requestClose)
  useFocusTrap(true, panel, undefined, layer)

  const focusField = (fieldId: string) => document.getElementById(fieldId)?.focus()

  return (
    <div className="fixed inset-0 flex justify-end p-3" style={{ zIndex: OVERLAY_Z.slideOver }}>
      <div aria-hidden="true" className="absolute inset-0 bg-ink-900/30" onClick={requestClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: WIDTH_PX[width] }}
        className="surface-solid relative flex h-full w-full flex-col overflow-hidden rounded-3xl"
        onChangeCapture={() => {
          touched.current = true
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-paper-2 px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-black text-ink-900">
              {title}
            </h2>
            {subtitle && <div className="text-sm text-ink-700">{subtitle}</div>}
          </div>
          <button
            type="button"
            aria-label="Tutup"
            onClick={requestClose}
            className="flex-shrink-0 rounded-xl bg-paper-1 p-2 text-ink-700 hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {errorSummary && errorSummary.length > 0 && (
          <div role="alert" className="mx-6 mt-4 rounded-xl bg-danger-bg px-3 py-2.5 text-sm text-danger">
            <p className="flex items-center gap-2 font-bold">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              {errorSummaryTitle ?? `${errorSummary.length} kolom perlu diperbaiki:`}
            </p>
            <ul className="mt-1 list-disc pl-10">
              {errorSummary.map((e) => (
                <li key={e.fieldId}>
                  <button type="button" className="underline" onClick={() => focusField(e.fieldId)}>
                    {e.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">{children}</div>
        {footer && <div className="sticky bottom-0 border-t border-paper-2 bg-(--surface-solid-bg) px-6 py-4">{footer}</div>}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Buang perubahan?"
        consequence="Perubahan yang belum disimpan akan hilang."
        confirmLabel="Buang perubahan"
        cancelLabel="Lanjut edit"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onClose()
        }}
      />
    </div>
  )
}

interface FooterProps {
  dirty?: boolean
  children: ReactNode
}

/** Footer row: the unsaved-changes note on the left, the buttons on the right. */
function Footer({ dirty, children }: FooterProps) {
  return (
    <div className="flex items-center gap-3">
      {dirty && <p className="mr-auto text-sm font-bold text-warn-strong">Perubahan belum disimpan</p>}
      <div className="ml-auto flex gap-2">{children}</div>
    </div>
  )
}

SlideOver.Footer = Footer
