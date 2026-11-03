import { useEffect, type RefObject } from 'react'
import { subscribeMoves } from '../lib/router/navigate'
import { canReach, remember, RESTORE_TIMEOUT_MS, scrollPlan } from '../lib/router/scroll'

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown'] as const

/** Scrolls `el` to `top` as soon as the content is tall enough (lazy chunks and data arrive late); gives up after a moment. */
function restoreWhenReachable(el: HTMLElement, top: number): () => void {
  const started = performance.now()
  let frame = 0
  const stop = (): void => {
    cancelAnimationFrame(frame)
    for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, stop)
  }
  const step = (): void => {
    if (canReach(top, el.scrollHeight, el.clientHeight) || performance.now() - started > RESTORE_TIMEOUT_MS) {
      el.scrollTo({ top })
      stop()
      return
    }
    frame = requestAnimationFrame(step)
  }
  // The person taking over the scroll wins over the restore.
  for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, stop, { passive: true })
  // The move fires before React renders the entry: wait a frame, or the first check measures the outgoing screen.
  frame = requestAnimationFrame(step)
  return stop
}

/**
 * A move to another path starts <main> at the top, Back/Forward puts the entry's own scroll back, and a move that only
 * changes the query (a filter, a page, an overlay) leaves the scroll alone. The outgoing scroll is read at the move,
 * before the screen re-renders.
 */
export function useScrollRestore(mainRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const saved = new Map<number, number>()
    let cancelRestore: (() => void) | undefined
    const off = subscribeMoves((move) => {
      const el = mainRef.current
      if (!el) return
      cancelRestore?.()
      cancelRestore = undefined
      remember(saved, move.from.idx, el.scrollTop)
      const plan = scrollPlan(move, saved)
      if (plan.kind === 'top') el.scrollTo({ top: 0 })
      else if (plan.kind === 'restore') cancelRestore = restoreWhenReachable(el, plan.top)
    })
    return () => {
      off()
      cancelRestore?.()
    }
  }, [mainRef])
}
