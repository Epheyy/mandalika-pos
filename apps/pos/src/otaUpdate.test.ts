import { beforeEach, describe, expect, it, vi } from 'vitest'

type Evt = { bundle: { id: string; version: string } }
const h = vi.hoisted(() => ({
  native: true,
  listener: null as null | ((e: { bundle: { id: string; version: string } }) => void),
  remove: vi.fn(async () => {}),
  next: null as null | { id: string; version: string },
  current: { bundle: { id: 'cur', version: '2.3.0' } },
  reload: vi.fn(async () => {}),
  addListener: vi.fn(),
  setMultiDelay: vi.fn(async () => {}),
  cancelDelay: vi.fn(async () => {}),
  set: vi.fn(async () => {}),
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }))
vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    addListener: h.addListener,
    getNextBundle: async () => h.next,
    current: async () => h.current,
    reload: h.reload,
    setMultiDelay: h.setMultiDelay,
    cancelDelay: h.cancelDelay,
    set: h.set,
  },
}))

beforeEach(() => {
  h.native = true
  h.listener = null
  h.next = null
  h.remove.mockClear()
  h.reload.mockClear()
  h.setMultiDelay.mockReset()
  h.setMultiDelay.mockResolvedValue(undefined)
  h.cancelDelay.mockClear()
  h.set.mockClear()
  h.addListener.mockReset()
  h.addListener.mockImplementation(async (_n: string, fn: (e: Evt) => void) => { h.listener = fn; return { remove: h.remove } })
})

describe('OTA glue (C5)', () => {
  it('is a silent no-op off-device: no plugin call, no throw', async () => {
    h.native = false
    const { watchOtaUpdates, reloadToApplyOta } = await import('./otaUpdate')
    const onReady = vi.fn()
    const off = await watchOtaUpdates(onReady)
    expect(() => off()).not.toThrow()
    await expect(reloadToApplyOta()).resolves.toBeUndefined()
    expect(h.addListener).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()
  })
  it('reports a bundle from the updateAvailable event and unsubscribes', async () => {
    const { watchOtaUpdates } = await import('./otaUpdate')
    const onReady = vi.fn()
    const off = await watchOtaUpdates(onReady)
    expect(h.addListener).toHaveBeenCalledWith('updateAvailable', expect.any(Function))
    h.listener!({ bundle: { id: 'b1', version: '2.3.1' } })
    expect(onReady).toHaveBeenCalledWith({ version: '2.3.1' })
    off()
    expect(h.remove).toHaveBeenCalled()
  })
  it('picks up a bundle queued before mount, but not builtin or the running one', async () => {
    const { watchOtaUpdates } = await import('./otaUpdate')
    h.next = { id: 'b2', version: '2.3.2' }
    const a = vi.fn()
    await watchOtaUpdates(a)
    expect(a).toHaveBeenCalledWith({ version: '2.3.2' })
    h.next = { id: 'builtin', version: 'builtin' }
    const b = vi.fn()
    await watchOtaUpdates(b)
    expect(b).not.toHaveBeenCalled()
    h.next = { id: 'cur', version: '2.3.0' }
    const c = vi.fn()
    await watchOtaUpdates(c)
    expect(c).not.toHaveBeenCalled()
  })
  it('ignores a builtin updateAvailable event', async () => {
    const { watchOtaUpdates } = await import('./otaUpdate')
    const onReady = vi.fn()
    await watchOtaUpdates(onReady)
    h.listener!({ bundle: { id: 'builtin', version: 'builtin' } })
    expect(onReady).not.toHaveBeenCalled()
  })
  it('survives a failing listener registration', async () => {
    const { watchOtaUpdates } = await import('./otaUpdate')
    h.addListener.mockRejectedValue(new Error('no plugin'))
    await expect(watchOtaUpdates(vi.fn())).resolves.toEqual(expect.any(Function))
  })
  it('reloadToApplyOta calls the plugin reload on-device', async () => {
    const { reloadToApplyOta } = await import('./otaUpdate')
    await reloadToApplyOta()
    expect(h.reload).toHaveBeenCalledTimes(1)
  })
  it('arms exactly a kill delay on device so a background cannot apply the queued bundle', async () => {
    const { armOtaKillDelay } = await import('./otaUpdate')
    await armOtaKillDelay()
    expect(h.setMultiDelay).toHaveBeenCalledTimes(1)
    expect(h.setMultiDelay).toHaveBeenCalledWith({ delayConditions: [{ kind: 'kill' }] })
  })
  it('arming is a silent no-op off-device and never throws when the plugin rejects', async () => {
    const { armOtaKillDelay } = await import('./otaUpdate')
    h.native = false
    await armOtaKillDelay()
    expect(h.setMultiDelay).not.toHaveBeenCalled()
    h.native = true
    h.setMultiDelay.mockRejectedValue(new Error('no plugin'))
    await expect(armOtaKillDelay()).resolves.toBeUndefined()
  })
  it('re-arms the delay whenever a bundle is queued (updateAvailable)', async () => {
    const { watchOtaUpdates } = await import('./otaUpdate')
    await watchOtaUpdates(vi.fn())
    h.listener!({ bundle: { id: 'b1', version: '2.4.0' } })
    await vi.waitFor(() => expect(h.setMultiDelay).toHaveBeenCalledWith({ delayConditions: [{ kind: 'kill' }] }))
  })
  it('the button path applies via reload() alone: no cancelDelay, no set, no extra delay calls', async () => {
    const { armOtaKillDelay, reloadToApplyOta } = await import('./otaUpdate')
    await armOtaKillDelay()
    h.setMultiDelay.mockClear()
    await reloadToApplyOta()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.cancelDelay).not.toHaveBeenCalled()
    expect(h.set).not.toHaveBeenCalled()
    expect(h.setMultiDelay).not.toHaveBeenCalled()
  })
})
