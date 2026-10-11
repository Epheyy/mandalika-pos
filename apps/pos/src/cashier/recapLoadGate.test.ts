import { describe, expect, it } from 'vitest'
import { RecapLoadGate, ownsFlags, switchTab } from './recapRefresh'

// The recap panel load, refresh and history races as a pure state machine.
describe('RecapLoadGate', () => {
  it('a fresh in-flight load is NOT discarded just because a refresh started after it', () => {
    const g = new RecapLoadGate()
    const load = g.begin()
    const refresh = g.issue()
    expect(g.canApply(load)).toBe(true)
    expect(g.apply(load, false)).toBe(false)
    expect(refresh).toBeGreaterThan(load)
  })

  it('an older response never overwrites a newer applied one', () => {
    const g = new RecapLoadGate()
    const slow = g.begin()
    const newer = g.begin()
    g.apply(newer, false)
    expect(g.canApply(slow)).toBe(false)
  })

  it('first load ok, refresh fails every attempt: data stays, banner shows', () => {
    const g = new RecapLoadGate()
    const load = g.begin()
    g.apply(load, false)
    g.issue(); g.issue()
    expect(g.giveUp()).toBe(true)
  })

  it('give-up then an OLD load landing fresh keeps the banner; a NEW fresh load clears it', () => {
    const g = new RecapLoadGate()
    const old = g.begin()
    g.issue()
    expect(g.giveUp()).toBe(true)
    expect(g.canApply(old)).toBe(true)
    expect(g.apply(old, false)).toBe(true) // predates the queue change
    const fresh = g.begin()
    expect(g.apply(fresh, false)).toBe(false)
  })

  it('a stale (cached) load always reports stale', () => {
    const g = new RecapLoadGate()
    expect(g.apply(g.begin(), true)).toBe(true)
  })

  it('a refresh superseded by a newer fresh load is covered, not retried and not a banner', () => {
    const g = new RecapLoadGate()
    const refresh = g.issue()
    const load = g.begin()
    g.apply(load, false)
    expect(g.resolveRefresh(refresh)).toBe('covered')
    expect(g.giveUp()).toBe(false)
  })

  it('a refresh superseded only by a stale load must retry', () => {
    const g = new RecapLoadGate()
    const refresh = g.issue()
    g.apply(g.begin(), true)
    expect(g.resolveRefresh(refresh)).toBe('retry')
  })

  it('a refresh with nothing newer applied applies', () => {
    const g = new RecapLoadGate()
    expect(g.resolveRefresh(g.issue())).toBe('apply')
  })

  it('loading clears when the newest load settles, or when none is pending (never waits on a hung older load)', () => {
    const g = new RecapLoadGate()
    const t1 = g.begin()
    const t2 = g.begin()
    expect(g.end(t1)).toBe(false) // an older load ending while a newer one runs
    expect(g.end(t2)).toBe(true)
    const g2 = new RecapLoadGate()
    const a = g2.begin()
    const b = g2.begin()
    expect(g2.end(b)).toBe(true) // newest done: a hung older load must not keep the skeleton up
    expect(g2.end(a)).toBe(true)
  })

  it('only the newest begun load may prefill the typed counts', () => {
    const g = new RecapLoadGate()
    const first = g.begin()
    g.issue() // a refresh does not count as a load
    expect(g.isNewestLoad(first)).toBe(true)
    const second = g.begin()
    expect(g.isNewestLoad(first)).toBe(false)
    expect(g.isNewestLoad(second)).toBe(true)
  })

  it('an older refresh cannot move applied backwards after a newer load applied', () => {
    const g = new RecapLoadGate()
    const refresh = g.issue()
    const load = g.begin()
    g.apply(load, false)
    expect(g.resolveRefresh(refresh)).toBe('covered')
  })
})

describe('tab helpers', () => {
  it('switching to the already active tab is a no-op', () => {
    expect(switchTab('rekapan', 'rekapan')).toBeNull()
    expect(switchTab('rekapan', 'riwayat')).toBe('riwayat')
  })
  it('only the visible tab owns the shared loading/stale/error flags', () => {
    expect(ownsFlags('riwayat', 'rekapan')).toBe(false) // a delayed loadRekap while on Riwayat
    expect(ownsFlags('rekapan', 'rekapan')).toBe(true)
  })

  it('history and rekapan use independent gates', () => {
    const rekap = new RecapLoadGate()
    const hist = new RecapLoadGate()
    const r = rekap.begin()
    const h = hist.begin()
    rekap.apply(r, false)
    expect(hist.canApply(h)).toBe(true)
  })
})
