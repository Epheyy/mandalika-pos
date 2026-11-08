import { useEffect, useRef, type RefObject } from 'react'

/**
 * Stack of open Sheets (bottom to top). Module state on purpose: a Profil Pelanggan sheet opened over the
 * Pelanggan picker must know it is on top without the two components knowing each other.
 * Focus, Tab, Escape and inertness are only managed for the topmost layer; Android Back is not touched here.
 */
interface Layer {
  id: string
  overlay: () => HTMLElement | null
  onEscape: () => void
}

const stack: Layer[] = []
/** Elements this module has marked inert, so each recompute can undo its own marks and nothing else. */
let marked: HTMLElement[] = []

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') && (el.getClientRects().length > 0 || el === document.activeElement),
  )
}

export const isTopLayer = (id: string): boolean => stack[stack.length - 1]?.id === id
export const layerDepth = (): number => stack.length

/** Test hook. */
export function resetSheetLayers(): void {
  stack.length = 0
  marked = []
}

function markInert(el: Element): void {
  if (!(el instanceof HTMLElement) || el.hasAttribute('inert')) return
  el.setAttribute('inert', '')
  marked.push(el)
}

/**
 * Lower layers become inert so assistive tech and Shift+Tab cannot reach them. A sheet can be nested in the DOM
 * inside the one below it (JSX child), so a lower overlay that contains the top one is not inerted whole: only its
 * off-path siblings are, down to the top overlay.
 */
function applyInert(): void {
  for (const el of marked) el.removeAttribute('inert')
  marked = []
  const top = stack[stack.length - 1]?.overlay()
  if (!top) return
  for (const layer of stack.slice(0, -1)) {
    const low = layer.overlay()
    if (!low) continue
    if (!low.contains(top)) {
      markInert(low)
      continue
    }
    let node: HTMLElement = top
    while (node !== low && node.parentElement) {
      const parent: HTMLElement = node.parentElement
      for (const sib of Array.from(parent.children)) if (sib !== node) markInert(sib)
      node = parent
    }
  }
}

/**
 * Registers the sheet as a layer while mounted. Escape goes to the top layer's `onEscape` only (callers may make it
 * a no-op, e.g. checkout while processing: that is respected). Focus moves to the panel on open (not to the first
 * field, so no on-screen keyboard pops up), Tab wraps inside the top panel, and focus returns to the opener on close.
 */
export function useSheetLayer(
  id: string,
  panel: RefObject<HTMLElement | null>,
  onEscape: (() => void) | undefined,
): void {
  const escape = useRef(onEscape)
  useEffect(() => {
    escape.current = onEscape
  })
  useEffect(() => {
    const root = panel.current
    if (!root) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const layer: Layer = {
      id,
      overlay: () => root.parentElement,
      onEscape: () => escape.current?.(),
    }
    // React runs a nested sheet's effects before its parent's, so a parent that mounts in the same commit would land
    // above its own child. A layer whose overlay contains another layer's overlay always sits below it.
    const firstInside = stack.findIndex((l) => {
      const o = l.overlay()
      return !!o && o !== root.parentElement && !!root.parentElement?.contains(o)
    })
    if (firstInside >= 0) stack.splice(firstInside, 0, layer)
    else stack.push(layer)
    applyInert()
    // An autofocused child keeps focus; otherwise the panel takes it.
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(id)) return
      if (e.key === 'Escape') {
        // An inner control (e.g. a picker) that already used this Escape keeps it.
        if (e.defaultPrevented) return
        // preventDefault: an unhandled hardware Esc is mapped to Android Back, which would close a second layer.
        e.preventDefault()
        e.stopPropagation()
        layer.onEscape()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusableIn(root)
      if (items.length === 0) {
        e.preventDefault()
        root.focus()
        return
      }
      const head = items[0]
      const tail = items[items.length - 1]
      const at = document.activeElement
      if (e.shiftKey && (at === head || at === root || !root.contains(at))) {
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
      const at = stack.indexOf(layer)
      if (at >= 0) stack.splice(at, 1)
      applyInert()
      if (opener && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [id, panel])
}
