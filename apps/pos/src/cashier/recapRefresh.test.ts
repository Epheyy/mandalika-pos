import { describe, expect, it, vi } from 'vitest'
import { startRefresh } from './recapRefresh'

describe('startRefresh give up', () => {
  it('calls onGiveUp once after the final failed attempt, never on success', async () => {
    vi.useFakeTimers()
    const onGiveUp = vi.fn()
    startRefresh({ fetch: vi.fn().mockRejectedValue(new Error('x')), apply: vi.fn(), onGiveUp, maxAttempts: 3, baseMs: 100 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    const ok = vi.fn()
    startRefresh({ fetch: vi.fn().mockResolvedValue(1), apply: vi.fn(), onGiveUp: ok, maxAttempts: 3, baseMs: 100 })
    await vi.advanceTimersByTimeAsync(60000)
    expect(ok).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('does not call onGiveUp after cancel', async () => {
    vi.useFakeTimers()
    const onGiveUp = vi.fn()
    const cancel = startRefresh({ fetch: vi.fn().mockRejectedValue(new Error('x')), apply: vi.fn(), onGiveUp, maxAttempts: 2, baseMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    cancel()
    await vi.advanceTimersByTimeAsync(60000)
    expect(onGiveUp).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
