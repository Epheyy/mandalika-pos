import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type B = { id: string; version: string; status: string }
const h = vi.hoisted(() => ({
  native: true,
  next: null as null | { id: string; version: string; status: string },
  current: { bundle: { id: 'A', version: '2.3.0', status: 'success' } },
  reload: vi.fn(async () => {}),
  setMultiDelay: vi.fn(async () => {}),
  cancelDelay: vi.fn(async () => {}),
  set: vi.fn(async () => {}),
  getNextBundle: vi.fn(),
  currentFn: vi.fn(),
  store: new Map<string, string>(),
  storageBroken: false,
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => h.native } }))
vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    getNextBundle: h.getNextBundle,
    current: h.currentFn,
    reload: h.reload,
    setMultiDelay: h.setMultiDelay,
    cancelDelay: h.cancelDelay,
    set: h.set,
  },
}))

const queued = (over: Partial<B> = {}): B => ({ id: 'B', version: '2.4.0', status: 'pending', ...over })

beforeEach(() => {
  h.native = true
  h.next = queued()
  h.current = { bundle: { id: 'A', version: '2.3.0', status: 'success' } }
  h.store.clear()
  h.storageBroken = false
  h.reload.mockReset().mockResolvedValue(undefined)
  h.setMultiDelay.mockReset().mockResolvedValue(undefined)
  h.cancelDelay.mockClear()
  h.set.mockClear()
  h.getNextBundle.mockReset().mockImplementation(async () => h.next)
  h.currentFn.mockReset().mockImplementation(async () => h.current)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => {
      if (h.storageBroken) throw new Error('blocked')
      return h.store.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (h.storageBroken) throw new Error('blocked')
      h.store.set(k, v)
    },
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const run = async () => {
  const { startupOta } = await import('./otaUpdate')
  vi.useFakeTimers()
  const p = startupOta()
  await vi.advanceTimersByTimeAsync(10_000)
  await p
}

describe('decideColdApply (pure)', () => {
  const dec = async (o: Parameters<typeof import('./otaUpdate').decideColdApply>[0]) => (await import('./otaUpdate')).decideColdApply(o)
  it('applies a pending bundle over a confirmed current one', async () => {
    expect(await dec({ next: { id: 'B', status: 'pending' }, current: { id: 'A', status: 'success' }, triedId: null })).toBe('apply')
  })
  it.each([
    ['nothing queued', { next: null, current: { id: 'A', status: 'success' }, triedId: null }, 'none'],
    ['builtin queued', { next: { id: 'builtin', status: 'success' }, current: { id: 'A', status: 'success' }, triedId: null }, 'builtin'],
    ['errored bundle', { next: { id: 'B', status: 'error' }, current: { id: 'A', status: 'success' }, triedId: null }, 'unusable'],
    ['still downloading', { next: { id: 'B', status: 'downloading' }, current: { id: 'A', status: 'success' }, triedId: null }, 'unusable'],
    ['queued is the running bundle', { next: { id: 'A', status: 'pending' }, current: { id: 'A', status: 'success' }, triedId: null }, 'same'],
    ['current not yet confirmed', { next: { id: 'B', status: 'pending' }, current: { id: 'A', status: 'pending' }, triedId: null }, 'current-unconfirmed'],
    ['apply already tried for this id', { next: { id: 'B', status: 'pending' }, current: { id: 'A', status: 'success' }, triedId: 'B' }, 'already-tried'],
  ] as const)('%s -> %s', async (_n, o, want) => {
    expect(await dec(o as never)).toBe(want)
  })
  it('treats the builtin current bundle as confirmed', async () => {
    expect(await dec({ next: { id: 'B', status: 'pending' }, current: { id: 'builtin', status: 'success' }, triedId: null })).toBe('apply')
  })
  it('a tried marker for another id does not block', async () => {
    expect(await dec({ next: { id: 'C', status: 'pending' }, current: { id: 'A', status: 'success' }, triedId: 'B' })).toBe('apply')
  })
})

describe('startupOta (cold-start apply)', () => {
  it('arms the kill delay first, then applies a queued bundle once via reload() only', async () => {
    const order: string[] = []
    h.setMultiDelay.mockImplementation(async () => { order.push('arm') })
    h.reload.mockImplementation(async () => { order.push('reload') })
    await run()
    expect(order).toEqual(['arm', 'reload'])
    expect(h.setMultiDelay).toHaveBeenCalledWith({ delayConditions: [{ kind: 'kill' }] })
    expect(h.cancelDelay).not.toHaveBeenCalled()
    expect(h.set).not.toHaveBeenCalled()
  })
  it('writes the per-bundle marker BEFORE reloading', async () => {
    let markerAtReload: string | null = null
    h.reload.mockImplementation(async () => { markerAtReload = h.store.get('mandalika.pos.otaColdApplyTried') ?? null })
    await run()
    expect(markerAtReload).toBe('B')
  })
  it('does not loop: a second boot with the same bundle still queued (failed apply) does not reload again', async () => {
    await run()
    await run()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.setMultiDelay).toHaveBeenCalledTimes(2) // still armed on every boot
  })
  it('applies a newer bundle even after an earlier one was tried', async () => {
    await run()
    h.next = queued({ id: 'C', version: '2.5.0' })
    await run()
    expect(h.reload).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['nothing queued', () => { h.next = null }],
    ['builtin queued', () => { h.next = queued({ id: 'builtin', status: 'success' }) }],
    ['errored bundle (Capgo marked it failed)', () => { h.next = queued({ status: 'error' }) }],
    ['queued id equals the running id', () => { h.next = queued({ id: 'A' }) }],
    ['current bundle unconfirmed (freshly applied, no notifyAppReady yet)', () => { h.current = { bundle: { id: 'A', version: '2.3.0', status: 'pending' } } }],
    ['storage unavailable (loop guard impossible)', () => { h.storageBroken = true }],
  ])('skips the apply but still arms: %s', async (_n, setup) => {
    setup()
    await run()
    expect(h.reload).not.toHaveBeenCalled()
    expect(h.setMultiDelay).toHaveBeenCalledTimes(1)
  })
  it('a failing reload still waits for the dying page before boot continues, and the marker stays', async () => {
    h.reload.mockRejectedValue(new Error('Reload failed after applying pending bundle'))
    const { startupOta } = await import('./otaUpdate')
    vi.useFakeTimers()
    let done = false
    void startupOta().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1500)
    expect(done).toBe(false) // a native failure re-loads the WebView: do not start storage hydrate yet
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.store.get('mandalika.pos.otaColdApplyTried')).toBe('B')
  })
  it('swallows plugin errors and still resolves', async () => {
    h.getNextBundle.mockRejectedValue(new Error('no plugin method'))
    await expect(run()).resolves.toBeUndefined()
    expect(h.reload).not.toHaveBeenCalled()
    expect(h.setMultiDelay).toHaveBeenCalledTimes(1)
  })
  it('never hangs boot when the plugin never answers', async () => {
    h.getNextBundle.mockImplementation(() => new Promise(() => {}))
    h.setMultiDelay.mockImplementation(() => new Promise(() => {}))
    const { startupOta } = await import('./otaUpdate')
    vi.useFakeTimers()
    let done = false
    void startupOta().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(3500)
    expect(done).toBe(true)
    expect(h.reload).not.toHaveBeenCalled()
  })
  it('waits for the reload to take effect instead of continuing at once, but not forever', async () => {
    h.reload.mockImplementation(() => new Promise(() => {})) // WebView never replaced
    const { startupOta } = await import('./otaUpdate')
    vi.useFakeTimers()
    let done = false
    void startupOta().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(done).toBe(true)
  })
  it('is a silent no-op off-device', async () => {
    h.native = false
    const { startupOta } = await import('./otaUpdate')
    await expect(startupOta()).resolves.toBeUndefined()
    expect(h.setMultiDelay).not.toHaveBeenCalled()
    expect(h.getNextBundle).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
  })
})
