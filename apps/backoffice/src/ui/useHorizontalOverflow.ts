import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** A table this much wider than its card counts as overflowing (sub-pixel rounding must not flip it). */
const TOLERANCE_PX = 1

/**
 * Does the table need to scroll sideways inside its card?
 *
 * While it fits, the wrapper is `overflow-x: clip` (not a scroll container), so a sticky `th` keeps sticking to the
 * page scroller. Once the table is wider than the wrapper the caller switches the wrapper to `overflow-x: auto`
 * and drops the sticky header. Watches the table as well as the wrapper: data loading and column toggles resize the
 * table, not the wrapper.
 */
export function useHorizontalOverflow(): {
  wrapperRef: RefObject<HTMLDivElement | null>
  tableRef: RefObject<HTMLTableElement | null>
  overflowing: boolean
} {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const table = tableRef.current
    if (!wrapper || !table) return
    const measure = () => setOverflowing(table.offsetWidth - wrapper.clientWidth > TOLERANCE_PX)
    measure()
    // No ResizeObserver (very old WebView, jsdom without a stub): the first measurement stands.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    observer.observe(table)
    return () => observer.disconnect()
  }, [])

  return { wrapperRef, tableRef, overflowing }
}
