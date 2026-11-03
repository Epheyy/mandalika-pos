import { useEffect, useRef } from 'react'
import { pushLeaveGuard } from './navGuard'

/**
 * While `dirty`, the router and the shell call `askLeave` before they leave this screen (the browser's own
 * reload/close warning comes with any active guard, see navGuard). `askLeave` resolves true when the screen may be left.
 */
export function useUnsavedChanges(dirty: boolean, askLeave: () => Promise<boolean>): void {
  const askRef = useRef(askLeave)
  useEffect(() => {
    askRef.current = askLeave
  })

  useEffect(() => {
    if (!dirty) return
    return pushLeaveGuard(() => askRef.current())
  }, [dirty])
}
