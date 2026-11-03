import { useEffect, type RefObject } from 'react'
import { isTopOverlay } from './overlayStack'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/**
 * Keeps keyboard focus inside `container` while `active`: moves focus in on open (to `initial` when it
 * resolves, else the first focusable, else the container), wraps Tab / Shift+Tab, and returns focus to
 * the element that had it before. Effects only, so it is a no-op on the server.
 */
export function useFocusTrap(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  initial?: () => HTMLElement | null | undefined,
  /** The overlay layer id; while another layer is on top this trap leaves Tab alone. */
  layerId?: string,
): void {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = initial?.() ?? focusableIn(root)[0] ?? root
    first.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || (layerId !== undefined && !isTopOverlay(layerId))) return
      const items = focusableIn(root)
      if (items.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const head = items[0]
      const tail = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === head || !root.contains(at))) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && (at === tail || !root.contains(at))) {
        e.preventDefault()
        head.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener && opener.isConnected) opener.focus()
    }
    // `initial` is read once on open; the trap must not re-run (and steal focus) when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, container, layerId])
}
