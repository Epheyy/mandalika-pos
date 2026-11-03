/*
 * Leave guards. Something with unsaved work (Pengaturan, later a dirty SlideOver) pushes a guard;
 * the router awaits confirmLeave() before it moves, and the shell awaits it before signing out.
 * A guard shows its own question and resolves true when leaving is fine.
 *
 * It is a stack: only the top guard is asked. A dirty SlideOver opened over a dirty screen is asked first,
 * so Back closes the top layer before it touches the one below.
 */
export type LeaveGuard = () => Promise<boolean>

const guards: LeaveGuard[] = []

const warnBeforeUnload = (e: BeforeUnloadEvent): void => {
  e.preventDefault()
  e.returnValue = ''
}

// The browser's own "Leave site?" prompt, registered only while at least one guard is active.
let unloadWarning = false
function syncUnloadWarning(): void {
  if (typeof window === 'undefined') return
  const want = guards.length > 0
  if (want === unloadWarning) return
  unloadWarning = want
  if (want) window.addEventListener('beforeunload', warnBeforeUnload)
  else window.removeEventListener('beforeunload', warnBeforeUnload)
}

/** Push a guard; returns the function that removes exactly this one. */
export function pushLeaveGuard(guard: LeaveGuard): () => void {
  guards.push(guard)
  syncUnloadWarning()
  return () => {
    const at = guards.lastIndexOf(guard)
    if (at >= 0) guards.splice(at, 1)
    syncUnloadWarning()
  }
}

export const hasLeaveGuard = (): boolean => guards.length > 0

/** Asks the top guard only. True when nothing is guarded or the guard allows leaving. */
export async function confirmLeave(): Promise<boolean> {
  const top = guards[guards.length - 1]
  return top ? top() : true
}
