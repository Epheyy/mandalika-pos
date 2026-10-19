import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from '@mandalika/sync'
import { controllableKV } from '../../../../packages/sync/src/testFixtures/controllableKV'
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

describe('an online tablet is never locked by a wrong clock (A05)', () => {
  beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T08:00:00Z')) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('clock forward then a 2xx contact: no lock message, so add-to-cart and checkout are allowed', async () => {
    const request = vi.fn().mockResolvedValue({ data: { version: 0, dataManifest: {} } })
    const engine = new SyncEngine({ request }, {}, controllableKV().kv, { actor: null })
    await engine.checkVersion()
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z')) // +24 h, clock wrongly forward
    expect(offlineLockMessage(engine.offlineState())).toBe(OFFLINE_LOCKED_MESSAGE)
    vi.setSystemTime(new Date('2026-10-19T09:00:00Z')) // corrected; the tablet reaches the server
    await engine.checkVersion()
    expect(offlineLockMessage(engine.offlineState())).toBeNull()
  })
})
