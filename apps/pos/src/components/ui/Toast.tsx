import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createToastController, type ToastController, type ToastItem, type ToastOptions, type ToastTone } from './toastController'

export type { ToastOptions, ToastTone } from './toastController'

type ToastApi = {
  /** Show a toast. Returns its id, or null when a higher-severity toast (e.g. a warning) is visible and this one was dropped. */
  showToast: (message: string, options?: ToastOptions) => number | null
  /** Pass the id from showToast to clear only that toast; no id clears whatever is visible. */
  dismissToast: (id?: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Mount once near the app root (App.tsx). Screens call `useToast()`; nothing else renders a toast. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<ToastController | null>(null)
  if (controllerRef.current === null) controllerRef.current = createToastController()
  const controller = controllerRef.current
  const toast = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const api = useMemo<ToastApi>(() => ({ showToast: controller.show, dismissToast: controller.dismiss }), [controller])
  // Leaving the tree must not fire a timer into a dead provider.
  useEffect(() => controller.dismiss, [controller])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toast={toast} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}

// Warnings and errors are announced assertively; info and success politely. The surface is solid ink-900 with white text (plan §1.2, W1-27; owner
// rule: nothing read over content is see-through) and the tone is carried by the dot, so contrast never depends on a tint.
const DOT_CLASSES: Record<ToastTone, string> = {
  // Lighter tints than the page tones: the page tokens drop below 3:1 on ink-900 (WCAG 1.4.11).
  info: 'bg-[#8ab4f8]',
  ok: 'bg-[#6fd39a]',
  warn: 'bg-[#f5b94a]',
  danger: 'bg-[#ff8a80]',
}

export function ToastViewport({ toast }: { toast: ToastItem | null }) {
  const assertive = toast !== null && (toast.tone === 'warn' || toast.tone === 'danger')
  // Both live regions stay mounted: a region inserted together with its text is often not announced (TalkBack in the
  // Android WebView), so only the content inside changes. Keyed by id so a replacement toast re-renders its text.
  const body = toast && (
    <div
      key={toast.id}
      data-tone={toast.tone}
      className="flex max-w-md items-center gap-3 whitespace-pre-line rounded-control bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
    >
      <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT_CLASSES[toast.tone]}`} />
      <span>{toast.message}</span>
    </div>
  )
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4 safe-bottom">
      <div role="status" aria-live="polite">{assertive ? null : body}</div>
      <div role="alert" aria-live="assertive">{assertive ? body : null}</div>
    </div>
  )
}
