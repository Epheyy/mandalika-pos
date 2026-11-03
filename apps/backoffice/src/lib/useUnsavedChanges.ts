import { useEffect, useRef } from 'react'
import { registerNavGuard } from './navGuard'

/**
 * While `dirty`, the shell's leave checks call `askLeave` and the browser warns on reload/close.
 * `askLeave` resolves true when the screen may be left.
 */
export function useUnsavedChanges(dirty: boolean, askLeave: () => Promise<boolean>): void {
  const askRef = useRef(askLeave)
  useEffect(() => {
    askRef.current = askLeave
  })

  useEffect(() => {
    if (!dirty) return
    const unregister = registerNavGuard(() => askRef.current())
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      unregister()
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty])
}
