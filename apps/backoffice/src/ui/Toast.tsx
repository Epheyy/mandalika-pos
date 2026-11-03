import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { OVERLAY_Z } from './overlayStack'
import { cn } from './cn'

export interface ToastInput {
  message: string
  tone?: 'ok' | 'info' | 'warn'
  action?: { label: string; onClick: () => void }
  durationMs?: number
}

type Push = (t: ToastInput) => void

const DEFAULT_DURATION_MS = 5000
const TONE = { ok: 'border-ok text-ok', info: 'border-info text-info', warn: 'border-warn text-warn-strong' } as const

const ignore: Push = () => {}
const ToastCtx = createContext<Push>(ignore)

/** Show a message. Outside a provider it does nothing. Never repeat text that an inline role="alert" already shows. */
export function useToast(): Push {
  return use(ToastCtx)
}

interface Live extends ToastInput {
  key: number
}

/** Mount once near the root. The role="status" region is always mounted (so announcements are
 *  picked up) and never role="alert". */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Live[]>([])
  const next = useRef(0)

  const dismiss = useCallback((key: number) => {
    setItems((xs) => xs.filter((x) => x.key !== key))
  }, [])

  const push = useCallback<Push>((t) => {
    setItems((xs) => [...xs, { ...t, key: ++next.current }])
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
        style={{ zIndex: OVERLAY_Z.toast }}
      >
        {items.map((t) => (
          <ToastItem key={t.key} toast={t} onDismiss={() => dismiss(t.key)} />
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Auto-dismisses after its duration, but not while hovered or focused (WCAG 2.2.1). */
function ToastItem({ toast, onDismiss }: { toast: Live; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)
  const dismiss = useRef(onDismiss)
  useEffect(() => {
    dismiss.current = onDismiss
  })
  const duration = toast.durationMs ?? DEFAULT_DURATION_MS

  useEffect(() => {
    if (paused) return
    const t = setTimeout(() => dismiss.current(), duration)
    return () => clearTimeout(t)
  }, [paused, duration])

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn('flex items-center gap-3 rounded-xl border-l-4 bg-white px-4 py-3 text-sm font-bold shadow-lg', TONE[toast.tone ?? 'info'])}
    >
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs font-black underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-strong"
          onClick={() => {
            toast.action?.onClick()
            onDismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
}
