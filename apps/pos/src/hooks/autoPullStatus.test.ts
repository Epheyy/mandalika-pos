import { describe, expect, it } from 'vitest'
import { isResyncingNow, nextLastSyncedAt } from './autoPullStatus'

describe('isResyncingNow', () => {
  it('is true for a manual sync or an engine pull (auto or manual)', () => {
    expect(isResyncingNow(false, false)).toBe(false)
    expect(isResyncingNow(true, false)).toBe(true)
    expect(isResyncingNow(false, true)).toBe(true)
  })
})

describe('nextLastSyncedAt', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  it('returns null when the engine has not pulled yet', () => {
    expect(nextLastSyncedAt('2026-01-01T00:00:00.000Z', null)).toBeNull()
  })
  it('returns the new time when the pull is newer than the stored one', () => {
    expect(nextLastSyncedAt(iso(1000), 5000)).toBe(iso(5000))
    expect(nextLastSyncedAt(null, 5000)).toBe(iso(5000))
  })
  it('returns null (no change) when the stored time is already as new', () => {
    expect(nextLastSyncedAt(iso(5000), 5000)).toBeNull()
    expect(nextLastSyncedAt(iso(9000), 5000)).toBeNull()
  })
  it('treats an unparsable stored value as older', () => {
    expect(nextLastSyncedAt('garbage', 5000)).toBe(iso(5000))
  })
})
