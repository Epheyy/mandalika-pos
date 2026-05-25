export const MAX_PIN_ATTEMPTS = 5
export const LOCKOUT_MS = 5 * 60 * 1000 // 5 min cooldown after the cap

export interface Lockout {
  failures: number
  lockedUntil: number // epoch ms; 0 = not locked
}

export function reset(): Lockout {
  return { failures: 0, lockedUntil: 0 }
}

export function recordFailure(s: Lockout, now: number): Lockout {
  // If a prior lockout has fully elapsed, start a fresh failure count.
  const base = s.lockedUntil !== 0 && now >= s.lockedUntil ? 0 : s.failures
  const failures = base + 1
  const lockedUntil = failures >= MAX_PIN_ATTEMPTS ? now + LOCKOUT_MS : 0
  return { failures, lockedUntil }
}

export function canAttempt(s: Lockout, now: number): { allowed: boolean; remainingMs: number } {
  if (s.lockedUntil && now < s.lockedUntil) {
    return { allowed: false, remainingMs: s.lockedUntil - now }
  }
  return { allowed: true, remainingMs: 0 }
}
