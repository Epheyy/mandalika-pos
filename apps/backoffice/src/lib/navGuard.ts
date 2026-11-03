/*
 * A screen with unsaved work registers a guard; the shell awaits confirmLeave() before it
 * switches screens or signs out. The guard resolves true when leaving is fine.
 */
export type LeaveGuard = () => Promise<boolean>

let current: LeaveGuard | null = null

/** Register the active guard; returns an unregister that only clears it if it is still the active one. */
export function registerNavGuard(guard: LeaveGuard): () => void {
  current = guard
  return () => {
    if (current === guard) current = null
  }
}

export async function confirmLeave(): Promise<boolean> {
  return current ? current() : true
}
