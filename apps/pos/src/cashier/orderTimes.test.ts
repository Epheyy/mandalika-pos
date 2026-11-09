import { describe, expect, it } from 'vitest'
import { orderTimeLabels, RECEIVED_LATE_MS } from './orderTimes'

const WIB = 'Asia/Jakarta'
const NOW = new Date('2026-11-09T05:00:00Z')

describe('orderTimeLabels (F12/F26)', () => {
  it('never uses the chip words: an overnight sale shows its real date and time', () => {
    // Shift opened 8 Nov 22:00 WIB; sale at 9 Nov 01:31 WIB (= 8 Nov 18:31Z).
    const t = orderTimeLabels({ createdAt: '2026-11-08T18:31:00Z' }, WIB, NOW)
    expect(t.main).toBe('09 Nov 01:31')
    expect(t.main).not.toMatch(/Hari ini|Kemarin/)
    expect(t.received).toBeNull()
  })

  it('uses clientCreatedAt as the sale time and createdAt only as the server receive time', () => {
    // Offline sale at 01:31 WIB, synced 3 h 15 m later.
    const t = orderTimeLabels({ createdAt: '2026-11-09T01:46:00Z', clientCreatedAt: '2026-11-08T18:31:00Z' }, WIB, NOW)
    expect(t.main).toBe('09 Nov 01:31')
    expect(t.received).toBe('Diterima server 08:46')
  })

  it('names the day of the server time when it is not the sale day', () => {
    const t = orderTimeLabels({ createdAt: '2026-11-09T18:00:00Z', clientCreatedAt: '2026-11-09T05:00:00Z' }, WIB, NOW)
    expect(t.received).toBe('Diterima server 10 Nov 01:00')
  })

  it('hides the second time when the server heard within the threshold (online sale)', () => {
    const client = Date.parse('2026-11-09T03:00:00Z')
    const t = orderTimeLabels({ createdAt: new Date(client + RECEIVED_LATE_MS).toISOString(), clientCreatedAt: new Date(client).toISOString() }, WIB, NOW)
    expect(t.received).toBeNull()
    const late = orderTimeLabels({ createdAt: new Date(client + RECEIVED_LATE_MS + 60_000).toISOString(), clientCreatedAt: new Date(client).toISOString() }, WIB, NOW)
    expect(late.received).not.toBeNull()
  })

  it('falls back to createdAt when clientCreatedAt is missing or null', () => {
    for (const clientCreatedAt of [undefined, null]) {
      const t = orderTimeLabels({ createdAt: '2026-11-09T02:05:00Z', clientCreatedAt }, WIB, NOW)
      expect(t.main).toBe('09 Nov 09:05')
      expect(t.received).toBeNull()
    }
  })

  it('adds the year only when it differs from the current year, judged on the outlet clock', () => {
    expect(orderTimeLabels({ createdAt: '2025-12-31T17:30:00Z' }, WIB, NOW).main).toBe('01 Jan 00:30')
    expect(orderTimeLabels({ createdAt: '2025-12-30T17:30:00Z' }, WIB, NOW).main).toBe('31 Des 2025 00:30')
  })

  it('ignores a tablet time the backend would not trust (clock fast or reset)', () => {
    const fast = orderTimeLabels({ createdAt: '2026-11-09T02:00:00Z', clientCreatedAt: '2026-11-09T04:00:00Z' }, WIB, NOW)
    expect(fast.main).toBe('09 Nov 09:00')
    const reset = orderTimeLabels({ createdAt: '2026-11-09T02:00:00Z', clientCreatedAt: '2020-01-01T00:00:00Z' }, WIB, NOW)
    expect(reset.main).toBe('09 Nov 09:00')
    expect(reset.received).toBeNull()
  })

  it('does not throw on an unparseable time', () => {
    expect(orderTimeLabels({ createdAt: 'nope' }, WIB, NOW).main).toBe('-')
  })
})
