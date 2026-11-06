/**
 * Framework-free toast state machine behind `ToastProvider` (kept apart so the timer and precedence rules are unit-testable
 * without a DOM). One toast is visible at a time.
 *
 * - `duration` (ms) is per toast; `DEFAULT_TOAST_DURATION` when omitted or not a positive finite number.
 * - Every accepted `show` restarts the timer, so a later toast is never cut short by the previous toast's timer.
 * - Precedence: a toast replaces the visible one only when its severity is at least the visible one's. A warning
 *   (e.g. OVERSELL_WARNING) is therefore never replaced by an info toast like "Ditambahkan"; the lower toast is dropped
 *   (show returns null) and the visible one keeps its remaining time. Equal severity replaces (latest wins).
 */
export type ToastTone = 'info' | 'ok' | 'warn' | 'danger'

export type ToastItem = { id: number; message: string; tone: ToastTone }

export type ToastOptions = { duration?: number; tone?: ToastTone }

export const DEFAULT_TOAST_DURATION = 3000

const SEVERITY: Record<ToastTone, number> = { info: 0, ok: 1, warn: 2, danger: 3 }

export type ToastController = {
  getState: () => ToastItem | null
  subscribe: (listener: () => void) => () => void
  /** Returns the new toast's id, or null when a higher-severity toast is visible and this one was dropped. */
  show: (message: string, options?: ToastOptions) => number | null
  /** With an id, clears only that toast (a stale caller can't wipe a newer or higher-severity one); without, clears whatever is visible. */
  dismiss: (id?: number) => void
}

export function createToastController(): ToastController {
  let current: ToastItem | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextId = 1
  const listeners = new Set<() => void>()

  const emit = () => listeners.forEach((l) => l())
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const dismiss = (id?: number) => {
    if (current === null || (id !== undefined && id !== current.id)) return
    clearTimer()
    current = null
    emit()
  }

  return {
    getState: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    show: (message, options = {}) => {
      const tone = options.tone ?? 'info'
      if (current !== null && SEVERITY[tone] < SEVERITY[current.tone]) return null
      const duration =
        typeof options.duration === 'number' && Number.isFinite(options.duration) && options.duration > 0
          ? options.duration
          : DEFAULT_TOAST_DURATION
      clearTimer()
      const item: ToastItem = { id: nextId++, message, tone }
      current = item
      timer = setTimeout(() => dismiss(item.id), duration)
      emit()
      return item.id
    },
    dismiss,
  }
}
