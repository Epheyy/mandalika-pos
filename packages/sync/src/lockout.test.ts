import { describe, it, expect } from 'vitest'
import { canAttempt, recordFailure, reset, type Lockout, MAX_PIN_ATTEMPTS, LOCKOUT_MS } from './lockout'

const t0 = 1_000_000
describe('lockout', () => {
  it('allows attempts under the cap', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) s = recordFailure(s, t0)
    expect(canAttempt(s, t0).allowed).toBe(true)
  })
  it('locks at the cap and reports remaining cooldown', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) s = recordFailure(s, t0)
    const c = canAttempt(s, t0)
    expect(c.allowed).toBe(false)
    expect(c.remainingMs).toBe(LOCKOUT_MS)
  })
  it('unlocks after cooldown elapses', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) s = recordFailure(s, t0)
    expect(canAttempt(s, t0 + LOCKOUT_MS + 1).allowed).toBe(true)
  })
  it('reset clears failures', () => {
    expect(canAttempt(reset(), t0).allowed).toBe(true)
  })
  it('starts a fresh failure batch after the cooldown elapses', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) s = recordFailure(s, t0) // locked at t0
    const after = recordFailure(s, t0 + LOCKOUT_MS + 1) // one wrong PIN after cooldown
    expect(after.failures).toBe(1)
    expect(canAttempt(after, t0 + LOCKOUT_MS + 2).allowed).toBe(true)
  })
})
