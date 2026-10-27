import { toneClasses, type Tone } from './tone'

type Props = {
  tone: Tone
  message: string
  /** One optional action, e.g. "Cek koneksi". */
  action?: { label: string; onClick: () => void }
  /** Makes the banner dismissible (a Tutup button after the action). */
  onDismiss?: () => void
  className?: string
}

/** A persistent notice (dismissible only when `onDismiss` is given) with at most one action. For things the cashier must act on, never a toast. */
export function Banner({ tone, message, action, onDismiss, className = '' }: Props) {
  return (
    <div role="alert" className={`flex flex-shrink-0 items-center justify-between gap-3 px-4 py-2 ${toneClasses(tone)} ${className}`.trim()}>
      <span className="text-sm font-semibold">{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="min-h-11 flex-shrink-0 rounded-lg bg-white px-4 text-sm font-semibold text-ink-700 border border-paper-2"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Tutup" className="min-h-11 flex-shrink-0 px-2 text-sm font-semibold">
          ✕
        </button>
      )}
    </div>
  )
}
