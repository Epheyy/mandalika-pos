/**
 * Soft-keyboard inset. The APK runs edge-to-edge in immersive mode, so the WebView is never resized when the Android
 * keyboard opens: `innerHeight` stays put while `visualViewport.height` shrinks (measured on an SM-X115: 601 -> 299
 * landscape, 1006 -> 675 portrait). `interactive-widget` in the viewport meta has no effect there. We publish the
 * covered height as `--kb` on <html>; `Sheet` ends its fixed container at `bottom: var(--kb, 0px)`.
 */

type ViewportLike = { height: number; offsetTop: number; scale: number }

/** Gaps below this are toolbar / URL-bar jitter, not a keyboard (the smallest real keyboard here is ~300px). */
export const KEYBOARD_MIN_INSET_PX = 80
/** Above this scale the visual viewport is pinch-zoomed and its height says nothing about a keyboard. */
const PINCH_ZOOM_SCALE = 1.01

/** Height (px) of the soft keyboard covering the layout viewport; a non-negative integer, 0 when none. */
export function keyboardInsetPx(innerHeight: number, vv: ViewportLike): number {
  if (vv.scale > PINCH_ZOOM_SCALE) return 0
  const gap = Math.round(innerHeight - vv.height - vv.offsetTop)
  return gap >= KEYBOARD_MIN_INSET_PX ? gap : 0
}

/** Starts publishing `--kb`. No-op without `visualViewport`. Returns a cleanup that removes listeners and the var. */
export function installKeyboardInset(win: Window & typeof globalThis = window): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  const root = win.document.documentElement
  let last = 0
  let frame = 0

  const update = () => {
    const next = keyboardInsetPx(win.innerHeight, vv)
    if (next === last) return
    const opened = last === 0 && next > 0
    last = next
    root.style.setProperty('--kb', `${next}px`)
    if (!opened) return
    // Wait for the layout to settle on the new bottom, then keep a field low in a sheet in view.
    frame = win.requestAnimationFrame(() => {
      const el = win.document.activeElement
      if ((el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) && el.closest('[role=dialog]')) {
        el.scrollIntoView({ block: 'nearest' })
      }
    })
  }

  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  win.addEventListener('resize', update)
  update()

  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    win.removeEventListener('resize', update)
    if (frame) win.cancelAnimationFrame(frame)
    root.style.removeProperty('--kb')
  }
}
