import {
  createContext,
  use,
  useCallback,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from './cn'
import { useFocusTrap } from './focus'
import { OVERLAY_Z, useOverlayLayer } from './overlayStack'

export interface ConfirmDialogProps {
  open: boolean
  /** A question: "Kirim transfer TR-0142?" */
  title: string
  /** One sentence on what happens: "Stok 12 unit akan keluar dari Gudang Pusat sekarang." */
  consequence: ReactNode
  /** A verb phrase: "Kirim transfer". */
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  /** 'cancel' starts focus on Batal even for a default-tone question, so a fast double Enter cannot answer it unread
   *  (the D-79 activation questions). Unset keeps the usual start: Batal for danger, else the field or confirm. */
  initialFocus?: 'cancel'
  busy?: boolean
  /** Server refusal, shown inside the dialog (role="alert"); the dialog stays open. */
  error?: string | null
  /** A third action, e.g. the leave guard's "Buang perubahan". */
  extra?: { label: string; tone: 'danger' | 'ghost'; onClick: () => void }
  /** A required or optional text answer, e.g. "Alasan pembatalan" (replaces window.prompt). */
  input?: { label: string; required?: boolean; multiline?: boolean; maxLength?: number }
  onConfirm: (value?: string) => void | Promise<void>
  onCancel: () => void
}

const BUTTON =
  'px-4 py-2.5 rounded-xl text-sm font-bold transition-colors focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand-strong disabled:cursor-not-allowed disabled:opacity-50'

/** Where focus lands when the dialog opens. */
export function initialFocusTarget(o: { tone?: 'default' | 'danger'; initialFocus?: 'cancel'; hasInput: boolean }): 'cancel' | 'field' | 'confirm' {
  if (o.tone === 'danger' || o.initialFocus === 'cancel') return 'cancel'
  return o.hasInput ? 'field' : 'confirm'
}

/** Modal question. role="alertdialog"; focus starts on Batal for a danger action or `initialFocus="cancel"`, else on the text field or
 *  the confirm button; Escape and the backdrop cancel, except while busy. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null
  return <ConfirmBody {...props} />
}

function ConfirmBody({
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Batal',
  tone = 'default',
  initialFocus,
  busy = false,
  error,
  extra,
  input,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const uid = useId()
  const titleId = `${uid}-title`
  const descId = `${uid}-desc`
  const fieldId = `${uid}-field`
  const panel = useRef<HTMLDivElement>(null)
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const confirmBtn = useRef<HTMLButtonElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const textbox = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  const cancel = () => {
    if (!busy) onCancel()
  }
  const layer = useOverlayLayer(true, cancel)
  useFocusTrap(
    true,
    panel,
    () =>
      initialFocusTarget({ tone, initialFocus, hasInput: !!input }) === 'cancel'
        ? cancelBtn.current
        : (textarea.current ?? textbox.current ?? confirmBtn.current),
    layer,
  )

  const missing = !!input?.required && value.trim() === ''
  const danger = tone === 'danger'
  const fieldClass =
    'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-strong'

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: OVERLAY_Z.confirm }}>
      <div aria-hidden="true" className="absolute inset-0 bg-ink-900/40" onClick={cancel} />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="surface-solid relative w-full max-w-sm rounded-3xl p-6"
      >
        <h2 id={titleId} className="text-lg font-black text-ink-900">
          {title}
        </h2>
        <div id={descId} className="mt-1 text-sm text-ink-700">
          {consequence}
        </div>
        {input && (
          <div className="mt-4">
            <label htmlFor={fieldId} className="mb-1 block text-xs font-bold text-ink-700">
              {input.label}
            </label>
            {input.multiline ? (
              <textarea
                id={fieldId}
                ref={textarea}
                rows={3}
                value={value}
                maxLength={input.maxLength}
                disabled={busy}
                required={input.required}
                onChange={(e) => setValue(e.target.value)}
                className={cn(fieldClass, 'resize-none')}
              />
            ) : (
              <input
                id={fieldId}
                ref={textbox}
                value={value}
                maxLength={input.maxLength}
                disabled={busy}
                required={input.required}
                onChange={(e) => setValue(e.target.value)}
                className={fieldClass}
              />
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {extra && (
            <button
              type="button"
              disabled={busy}
              onClick={extra.onClick}
              className={cn(BUTTON, 'mr-auto', extra.tone === 'danger' ? 'text-danger hover:bg-danger-bg' : 'text-ink-700 hover:bg-paper-1')}
            >
              {extra.label}
            </button>
          )}
          <button
            ref={cancelBtn}
            type="button"
            disabled={busy}
            onClick={cancel}
            className={cn(BUTTON, 'border border-paper-2 bg-white text-ink-700 hover:bg-paper-1')}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtn}
            type="button"
            disabled={busy || missing}
            onClick={() => void onConfirm(input ? value.trim() : undefined)}
            className={cn(BUTTON, 'text-on-brand', danger ? 'bg-danger-solid hover:opacity-90' : 'bg-brand-strong hover:bg-brand-strong-hover')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- useConfirm: promise-style confirmations for flows with nothing to keep open on failure ----

export type ConfirmOptions = Omit<ConfirmDialogProps, 'open' | 'onConfirm' | 'onCancel'>
export interface ConfirmResult {
  confirmed: boolean
  value?: string
}
type Ask = (opts: ConfirmOptions) => Promise<ConfirmResult>

// Without a provider (tests, server markup) a confirmation is declined: nothing destructive runs unasked.
const declined: Ask = () => Promise.resolve({ confirmed: false })
const ConfirmCtx = createContext<Ask>(declined)

export function useConfirm(): Ask {
  return use(ConfirmCtx)
}

interface Pending {
  seq: number
  opts: ConfirmOptions
  resolve: (r: ConfirmResult) => void
}

/** Mount once near the root. Asking while a question is open declines the open one first. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const seq = useRef(0)
  const ask = useCallback<Ask>(
    (opts) =>
      new Promise<ConfirmResult>((resolve) => {
        setPending((prev) => {
          prev?.resolve({ confirmed: false })
          return { seq: ++seq.current, opts, resolve }
        })
      }),
    [],
  )
  const settle = (r: ConfirmResult) => {
    pending?.resolve(r)
    setPending(null)
  }
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.seq}
          {...pending.opts}
          open
          onCancel={() => settle({ confirmed: false })}
          onConfirm={(value) => settle({ confirmed: true, value })}
        />
      )}
    </ConfirmCtx.Provider>
  )
}
