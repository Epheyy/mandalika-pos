import { useEffect, useRef } from 'react'
import { pushLeaveGuard, type GuardOptions } from './navGuard'

/**
 * While `dirty`, the router and the shell call `askLeave` before they leave this screen (the browser's own
 * reload/close warning comes with any active guard, see navGuard). `askLeave` resolves true when the screen may be left.
 * `scope` is the screen's path prefix: moves under it (its own tabs) do not ask.
 */
export function useUnsavedChanges(dirty: boolean, askLeave: () => Promise<boolean>, scope?: GuardOptions['scope']): void {
  const askRef = useRef(askLeave)
  useEffect(() => {
    askRef.current = askLeave
  })

  const scopeKey = scope?.join('/')
  useEffect(() => {
    if (!dirty) return
    return pushLeaveGuard(() => askRef.current(), scopeKey === undefined ? {} : { scope: scopeKey.split('/') })
  }, [dirty, scopeKey])
}
