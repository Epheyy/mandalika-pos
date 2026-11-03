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

/** Mount once near the root. The role="status" region only exists while a toast is showing (never role="alert"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Live[]>([])
  const next = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((key: number) => {
    const t = timers.current.get(key)
    if (t) clearTimeout(t)
    timers.current.delete(key)
    setItems((xs) => xs.filter((x) => x.key !== key))
  }, [])

  const push = useCallback<Push>(
    (t) => {
      const key = ++next.current
      setItems((xs) => [...xs, { ...t, key }])
      timers.current.set(key, setTimeout(() => dismiss(key), t.durationMs ?? DEFAULT_DURATION_MS))
    },
    [dismiss],
  )

  useEffect(() => {
    const live = timers.current
    return () => live.forEach((t) => clearTimeout(t))
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {items.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
          style={{ zIndex: OVERLAY_Z.toast }}
        >
          {items.map((t) => (
            <div
              key={t.key}
              className={cn('flex items-center gap-3 rounded-xl border-l-4 bg-white px-4 py-3 text-sm font-bold shadow-lg', TONE[t.tone ?? 'info'])}
            >
              <span className="flex-1">{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-xs font-black underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  onClick={() => {
                    t.action?.onClick()
                    dismiss(t.key)
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </ToastCtx.Provider>
  )
}
