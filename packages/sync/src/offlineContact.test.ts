import { describe, expect, it } from 'vitest'
import {
  OFFLINE_CAP_MS, OFFLINE_CONTACT_KEY, OFFLINE_WARN_MS, OfflineContact, offlineCapState, type ContactRecord,
} from './offlineContact'
import { controllableKV } from './testFixtures/controllableKV'

const H = 3_600_000
const T0 = Date.parse('2026-10-19T08:00:00Z')
const rec = (over: Partial<ContactRecord> = {}): ContactRecord => ({ v: 1, deviceAt: T0, highWater: T0, ...over })

describe('offlineCapState', () => {
  it('is unknown without a record: nothing blocks, the server decides', () => {
    expect(offlineCapState(T0 + 99 * H, null)).toEqual({ level: 'unknown', offlineMs: null })
  })
  it('walks ok -> warn (from 10 h) -> locked (from 12 h)', () => {
    expect(offlineCapState(T0 + 1 * H, rec()).level).toBe('ok')
    expect(offlineCapState(T0 + OFFLINE_WARN_MS - 1, rec()).level).toBe('ok')
    expect(offlineCapState(T0 + OFFLINE_WARN_MS, rec()).level).toBe('warn')
    expect(offlineCapState(T0 + OFFLINE_CAP_MS - 1, rec()).level).toBe('warn')
    expect(offlineCapState(T0 + OFFLINE_CAP_MS, rec()).level).toBe('locked')
  })
  it('a clock set back cannot shrink the window: the high-water mark holds', () => {
    const r = rec({ highWater: T0 + 11 * H })
    expect(offlineCapState(T0 + 1 * H, r)).toEqual({ level: 'warn', offlineMs: 11 * H })
  })
  it('the newest captured item also holds the window up', () => {
    expect(offlineCapState(T0 + 1 * H, rec(), T0 + 12 * H).level).toBe('locked')
  })
  it('a clock set forward blocks early', () => {
    expect(offlineCapState(T0 + 13 * H, rec()).level).toBe('locked')
  })
})

describe('OfflineContact', () => {
  const make = (start = T0) => {
    const { kv, store } = controllableKV()
    let now = start
    const writes: string[] = []
    const origSet = kv.set.bind(kv)
    kv.set = (k: string, v: string) => { if (k === OFFLINE_CONTACT_KEY) writes.push(v); origSet(k, v) }
    const oc = new OfflineContact(kv, () => now)
    return { oc, kv, store, writes, setNow: (n: number) => { now = n } }
  }

  it('has no record until the first 2xx contact', () => {
    const { oc } = make()
    expect(oc.record()).toBeNull()
    expect(oc.state().level).toBe('unknown')
    expect(oc.evidence()).toBeNull()
  })

  it('a signed contact is kept verbatim and reported as evidence', () => {
    const { oc } = make()
    oc.contact({ at: '2026-10-19T08:00:00.123Z', sig: 'abc' })
    expect(oc.evidence()).toEqual({
      contact: { at: '2026-10-19T08:00:00.123Z', sig: 'abc' }, contactDeviceAt: T0, offlineMs: 0,
    })
  })

  it('an unsigned contact (pull path, old server) drops the previous token', () => {
    const { oc, setNow } = make()
    oc.contact({ at: 'a', sig: 's' })
    setNow(T0 + H)
    oc.contact()
    expect(oc.record()).toEqual({ v: 1, deviceAt: T0 + H, highWater: T0 + H })
    expect(oc.evidence()).toEqual({ contactDeviceAt: T0 + H, offlineMs: 0 })
  })

  it('a contact resets the high-water mark', () => {
    const { oc, setNow } = make()
    oc.contact()
    setNow(T0 + 11 * H)
    expect(oc.state().level).toBe('warn')
    oc.contact()
    expect(oc.state()).toEqual({ level: 'ok', offlineMs: 0 })
  })

  it('persists the first contact at once, then at most every 60 s', () => {
    const { oc, writes, setNow } = make()
    oc.contact()
    expect(writes).toHaveLength(1)
    setNow(T0 + 20_000)
    oc.contact()
    setNow(T0 + 40_000)
    oc.contact()
    expect(writes).toHaveLength(1) // a lost write only makes the window look older
    setNow(T0 + 61_000)
    oc.contact()
    expect(writes).toHaveLength(2)
  })

  it('persists immediately on the first contact after an offline period', () => {
    const { oc, writes, setNow } = make()
    oc.contact()
    setNow(T0 + 30_000)
    oc.contact() // throttled
    setNow(T0 + 30_000 + 3 * H)
    oc.state() // time passes offline: advances the high-water mark
    oc.contact()
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(writes[writes.length - 1]).deviceAt).toBe(T0 + 30_000 + 3 * H)
  })

  it('advancing offline time is persisted on the same throttle', () => {
    const { oc, writes, setNow } = make()
    oc.contact()
    setNow(T0 + 70_000)
    oc.state()
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1]).highWater).toBe(T0 + 70_000)
  })

  it('survives a reboot: the record reloads from storage', () => {
    const { oc, kv, setNow } = make()
    oc.contact({ at: 'a', sig: 's' })
    setNow(T0 + 5 * H)
    oc.state()
    const again = new OfflineContact(kv, () => T0 + 6 * H)
    expect(again.record()?.deviceAt).toBe(T0)
    expect(again.state().level).toBe('ok')
  })

  it('ignores a corrupt or foreign stored value', () => {
    const { kv } = make()
    kv.set(OFFLINE_CONTACT_KEY, '{"v":2,"deviceAt":"x"}')
    expect(new OfflineContact(kv, () => T0).record()).toBeNull()
    kv.set(OFFLINE_CONTACT_KEY, 'not json')
    expect(new OfflineContact(kv, () => T0).record()).toBeNull()
  })

  it('evidence never reports a negative offline time', () => {
    const { oc, setNow } = make()
    oc.contact()
    setNow(T0 - H) // clock set back: high-water holds it at zero, never negative
    expect(oc.evidence()!.offlineMs).toBe(0)
  })
})
