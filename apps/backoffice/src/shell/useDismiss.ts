import { useEffect, type RefObject } from 'react'

/** Closes a popover on Escape or a press outside `ref` (the trigger button should sit inside `ref` too). */
export function useDismiss(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    const onPress = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPress)
    }
  }, [open, onClose, ref])
}
