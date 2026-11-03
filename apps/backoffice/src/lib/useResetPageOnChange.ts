import { useEffect, useRef } from 'react'

/** Calls `reset` when `scope` changes while the list is past page 1: a page number from the old scope can be empty in the new one. */
export function useResetPageOnChange(scope: unknown, page: number, reset: () => void): void {
  const previous = useRef(scope)
  useEffect(() => {
    if (previous.current === scope) return
    previous.current = scope
    if (page !== 1) reset()
  }, [scope, page, reset])
}
