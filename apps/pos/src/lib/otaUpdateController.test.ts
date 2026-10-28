import { describe, expect, it, vi } from 'vitest'
import type { OtaPending, OtaWatch } from '../otaUpdate'
import type { OtaGateInput } from './otaApplyGate'
import { createOtaUpdateController, OTA_RESTART_ERROR } from './otaUpdateController'

const idle: OtaGateInput = { cartCount: 0, isCheckoutOpen: false, isProcessing: false, isSuccessOpen: false, refundActive: false, writesInFlight: false }
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function setup(reload: () => Promise<void> = async () => {}) {
  let emit: (p: OtaPending) => void = () => {}
  const off = vi.fn()
  const watch: OtaWatch = vi.fn(async (onReady) => { emit = onReady; return off })
  const reloadFn = vi.fn(reload)
  const c = createOtaUpdateController({ watch, reload: reloadFn })
  c.start()
  return { c, emit: (p: OtaPending) => emit(p), off, watch, reload: reloadFn }
}

describe('OTA update controller (C5)', () => {
  it('holds a downloaded version and never reloads by itself', () => {
    const t = setup()
    t.emit({ version: '2.3.1' })
    expect(t.c.getSnapshot().pending).toEqual({ version: '2.3.1' })
    expect(t.reload).not.toHaveBeenCalled()
  })
  it('keeps the snapshot identity when the same version is re-announced', () => {
    const t = setup()
    t.emit({ version: '2.3.1' })
    const snap = t.c.getSnapshot()
    const l = vi.fn()
    t.c.subscribe(l)
    t.emit({ version: '2.3.1' })
    expect(t.c.getSnapshot()).toBe(snap)
    expect(l).not.toHaveBeenCalled()
  })
  it('restart does nothing without a pending update', async () => {
    const t = setup()
    expect(await t.c.restart(() => idle)).toBe('none')
    expect(t.reload).not.toHaveBeenCalled()
  })
  it.each([
    { cartCount: 1 }, { isCheckoutOpen: true }, { isProcessing: true }, { isSuccessOpen: true }, { refundActive: true }, { writesInFlight: true },
  ])('refuses to reload while %o', async (over) => {
    const t = setup()
    t.emit({ version: '2.3.1' })
    expect(await t.c.restart(() => ({ ...idle, ...over }))).toBe('blocked')
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.c.getSnapshot().applying).toBe(false)
  })
  it('re-reads the gate at call time (a sale that began after the last render still blocks)', async () => {
    const t = setup()
    t.emit({ version: '2.3.1' })
    let busy = false
    const read = () => ({ ...idle, writesInFlight: busy })
    expect(t.c.blockReason(read)).toBeNull()
    busy = true
    expect(await t.c.restart(read)).toBe('blocked')
    expect(t.reload).not.toHaveBeenCalled()
  })
  it('reloads once when idle, and ignores a second tap while applying', async () => {
    let release: () => void = () => {}
    const t = setup(() => new Promise<void>((r) => { release = r }))
    t.emit({ version: '2.3.1' })
    const first = t.c.restart(() => idle)
    expect(t.c.getSnapshot().applying).toBe(true)
    expect(await t.c.restart(() => idle)).toBe('busy')
    release()
    expect(await first).toBe('applied')
    expect(t.reload).toHaveBeenCalledTimes(1)
  })
  it('surfaces a failed reload and allows a retry', async () => {
    const t = setup(async () => { throw new Error('boom') })
    t.emit({ version: '2.3.1' })
    expect(await t.c.restart(() => idle)).toBe('failed')
    expect(t.c.getSnapshot()).toMatchObject({ applying: false, error: OTA_RESTART_ERROR })
  })
  it('stop unsubscribes, including when stop happens before watch resolves', async () => {
    const t = setup()
    await flush()
    t.c.stop()
    expect(t.off).toHaveBeenCalledTimes(1)
    const off2 = vi.fn()
    let resolve: (f: () => void) => void = () => {}
    const c2 = createOtaUpdateController({ watch: () => new Promise((r) => { resolve = r }), reload: async () => {} })
    c2.start()
    c2.stop()
    resolve(off2)
    await flush()
    expect(off2).toHaveBeenCalledTimes(1)
  })
  it('ignores events from a stopped watcher (StrictMode start/stop/start)', () => {
    const emits: Array<(p: OtaPending) => void> = []
    const watch: OtaWatch = vi.fn(async (onReady) => { emits.push(onReady); return () => {} })
    const c = createOtaUpdateController({ watch, reload: async () => {} })
    c.start()
    c.stop()
    c.start()
    emits[0]({ version: 'stale' })
    expect(c.getSnapshot().pending).toBeNull()
    emits[1]({ version: '2.3.1' })
    expect(c.getSnapshot().pending).toEqual({ version: '2.3.1' })
  })
})
