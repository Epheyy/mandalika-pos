import { describe, expect, it } from 'vitest'
import { OFFLINE_LOCKED_MESSAGE, offlineLockMessage, offlineWarnMessage } from './offlineCap'

const H = 3_600_000
const state = (level: 'unknown' | 'ok' | 'warn' | 'locked', offlineMs: number | null) => ({ level, offlineMs })

describe('offlineLockMessage', () => {
  it('locks only at the locked level', () => {
    expect(offlineLockMessage(state('locked', 12 * H))).toBe(OFFLINE_LOCKED_MESSAGE)
    for (const s of [state('unknown', null), state('ok', H), state('warn', 11 * H)]) {
      expect(offlineLockMessage(s)).toBeNull()
    }
  })
  it('states what is locked and that recorded work is safe', () => {
    expect(OFFLINE_LOCKED_MESSAGE).toContain('12 jam')
    expect(OFFLINE_LOCKED_MESSAGE).toContain('Penjualan, refund, dan kas masuk/keluar')
    expect(OFFLINE_LOCKED_MESSAGE).toContain('tetap aman')
  })
})

describe('offlineWarnMessage', () => {
  it('warns with whole hours from the warn level', () => {
    expect(offlineWarnMessage(state('warn', 10.9 * H))).toBe(
      'Tablet offline 10 jam. Sambungkan internet sebelum 12 jam agar penjualan tidak terkunci.',
    )
  })
  it('is silent for every other level', () => {
    for (const s of [state('unknown', null), state('ok', H), state('locked', 13 * H)]) {
      expect(offlineWarnMessage(s)).toBeNull()
    }
  })
})
