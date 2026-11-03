import { useEffect, useId, useRef } from 'react'

/** One shared z-order for every overlay. Higher layers cover lower ones. */
export const OVERLAY_Z = { modal: 50, slideOver: 55, confirm: 60, toast: 70 } as const

// Layers that are currently open, bottom to top. Module state on purpose: a stacked SlideOver over a
// Modal must know it is on top without the two components knowing each other.
const stack: string[] = []

export const isTopOverlay = (layerId: string): boolean => stack[stack.length - 1] === layerId
export const overlayDepth = (): number => stack.length

/** Test hook: forget every layer. */
export function resetOverlayStack(): void {
  stack.length = 0
}

/**
 * Registers an overlay as a layer while `active`, and runs `onEscape` for Escape only while it is the
 * top layer. A layer with no Escape behaviour still passes `() => {}` so it swallows the key instead of
 * letting the layer underneath close (the RecipeSlideOver-over-ProductFormModal bug).
 * Returns the layer id so a focus trap can stand down while another layer is on top.
 * Runs in effects only, so it is a no-op under renderToStaticMarkup.
 */
export function useOverlayLayer(active: boolean, onEscape: () => void): string {
  const layerId = useId()
  const handler = useRef(onEscape)
  useEffect(() => {
    handler.current = onEscape
  })
  useEffect(() => {
    if (!active) return
    stack.push(layerId)
    const onKey = (e: KeyboardEvent) => {
      // An inner control (e.g. a picker) that already used this Escape keeps it.
      if (e.key !== 'Escape' || e.defaultPrevented || !isTopOverlay(layerId)) return
      e.stopPropagation()
      handler.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const at = stack.lastIndexOf(layerId)
      if (at >= 0) stack.splice(at, 1)
    }
  }, [active, layerId])
  return layerId
}
